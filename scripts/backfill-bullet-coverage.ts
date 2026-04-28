import { eq, sql } from "drizzle-orm";
import Anthropic from "@anthropic-ai/sdk";
import { getAppDb, schema } from "../lib/db";
import { getApiKey, getCheapModel } from "../lib/settings";
import { recordCall } from "../lib/claude/tokens";

/**
 * Phase 16 / E3 — backfill `knowledge_bullet_idxs` and `skills_bullet_idxs`
 * on existing active questions whose arrays are still empty (legacy rows
 * from before the column was added).
 *
 * Strategy: group questions by parent task statement so Claude sees only the
 * relevant bullet pool per call. Use the cheap model (haiku tier) — this is
 * a one-shot classification, not a generation task. Each call requests a
 * batch of `{question_id → idx arrays}` to amortize the system prompt.
 *
 * Idempotency: skips questions whose arrays are already non-empty unless
 * `--force` is passed. Re-running on a clean DB is a no-op.
 *
 * Flags:
 *   --force                rewrite even questions that already have idxs
 *   --ts-id=D1.2           restrict to one task statement
 *   --batch-size=N         questions per Claude call (default 10)
 *   --max-questions=N      stop after this many backfilled (smoke testing)
 */

interface Args {
  force: boolean;
  tsId: string | null;
  batchSize: number;
  maxQuestions: number | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { force: false, tsId: null, batchSize: 10, maxQuestions: null };
  for (const a of argv) {
    if (a === "--force") args.force = true;
    else if (a.startsWith("--ts-id=")) args.tsId = a.slice("--ts-id=".length);
    else if (a.startsWith("--batch-size=")) {
      const n = Number.parseInt(a.slice("--batch-size=".length), 10);
      if (Number.isFinite(n) && n > 0) args.batchSize = Math.min(50, n);
    } else if (a.startsWith("--max-questions=")) {
      const n = Number.parseInt(a.slice("--max-questions=".length), 10);
      if (Number.isFinite(n) && n > 0) args.maxQuestions = n;
    }
  }
  return args;
}

interface BatchInput {
  question_id: string;
  knowledge_bullet_idxs: number[];
  skills_bullet_idxs: number[];
}

const tool: Anthropic.Tool = {
  name: "emit_bullet_citations",
  description:
    "Records which task-statement bullets each question tests. Cite by 0-based index into the bullet arrays shown for the parent task statement. Empty arrays are allowed only if the other array is non-empty — every question must trace to at least one bullet.",
  input_schema: {
    type: "object",
    properties: {
      classifications: {
        type: "array",
        items: {
          type: "object",
          properties: {
            question_id: { type: "string" },
            knowledge_bullet_idxs: {
              type: "array",
              items: { type: "integer", minimum: 0 },
            },
            skills_bullet_idxs: {
              type: "array",
              items: { type: "integer", minimum: 0 },
            },
          },
          required: [
            "question_id",
            "knowledge_bullet_idxs",
            "skills_bullet_idxs",
          ],
          additionalProperties: false,
        },
      },
    },
    required: ["classifications"],
    additionalProperties: false,
  },
};

function formatBulletsIndexed(bullets: string[]): string {
  return bullets.length === 0
    ? "(none)"
    : bullets.map((b, i) => `[${i}] ${b}`).join("\n");
}

async function classifyBatch(
  client: Anthropic,
  model: string,
  ts: typeof schema.taskStatements.$inferSelect,
  questions: Array<{ id: string; stem: string; options: string[] }>,
  db: ReturnType<typeof getAppDb>,
): Promise<BatchInput[]> {
  const start = Date.now();
  const response = await client.messages.create({
    model,
    max_tokens: 2048,
    tools: [tool],
    tool_choice: { type: "tool", name: "emit_bullet_citations" },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              `Task statement ${ts.id} — ${ts.title}\n\n` +
              `Knowledge bullets:\n${formatBulletsIndexed(ts.knowledgeBullets)}\n\n` +
              `Skills bullets:\n${formatBulletsIndexed(ts.skillsBullets)}\n\n` +
              `Cite which bullets each of the following ${questions.length} question` +
              `${questions.length === 1 ? "" : "s"} actually tests. Cite only the bullets the stem and key exercise — do not pad. Every question must cite at least one bullet across the two arrays.\n\n` +
              JSON.stringify(questions, null, 2),
          },
        ],
      },
    ],
  });
  recordCall(
    {
      role: "bullet-backfill",
      model,
      usage: response.usage,
      stopReason: response.stop_reason,
      durationMs: Date.now() - start,
    },
    db,
  );

  const toolUse = response.content.find((c) => c.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error(`backfill: no tool_use returned for TS ${ts.id}`);
  }
  const input = toolUse.input as { classifications: BatchInput[] };
  return input.classifications;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const db = getAppDb();
  const apiKey = getApiKey(db);
  if (!apiKey) {
    console.error(
      "no API key configured — paste one in /settings or set ANTHROPIC_API_KEY",
    );
    process.exit(1);
  }
  const model = getCheapModel(db);
  const client = new Anthropic({ apiKey });

  // Pull candidate questions. Filter to empty-citation rows unless --force.
  const tsRows = db
    .select()
    .from(schema.taskStatements)
    .all();
  const tsById = new Map(tsRows.map((t) => [t.id, t]));

  const allQuestions = db
    .select()
    .from(schema.questions)
    .where(eq(schema.questions.status, "active"))
    .all();

  const filtered = allQuestions.filter((q) => {
    if (args.tsId && q.taskStatementId !== args.tsId) return false;
    if (args.force) return true;
    const k = q.knowledgeBulletIdxs ?? [];
    const s = q.skillsBulletIdxs ?? [];
    return k.length === 0 && s.length === 0;
  });

  console.log(
    `[backfill] candidate questions: ${filtered.length} (force=${args.force}${args.tsId ? `, ts=${args.tsId}` : ""})`,
  );
  if (filtered.length === 0) {
    console.log("[backfill] nothing to do");
    return;
  }

  // Group by TS so each Claude call sees a focused bullet pool.
  const byTs = new Map<string, typeof filtered>();
  for (const q of filtered) {
    const bucket = byTs.get(q.taskStatementId) ?? [];
    bucket.push(q);
    byTs.set(q.taskStatementId, bucket);
  }

  let processed = 0;
  let updated = 0;
  let invalid = 0;
  const cap = args.maxQuestions ?? Infinity;

  for (const [tsId, qs] of byTs) {
    const ts = tsById.get(tsId);
    if (!ts) {
      console.warn(`[backfill] task statement ${tsId} not found — skipping`);
      continue;
    }
    if (ts.knowledgeBullets.length === 0 && ts.skillsBullets.length === 0) {
      console.warn(
        `[backfill] ${tsId} has no bullets — skipping ${qs.length} questions`,
      );
      continue;
    }
    for (let i = 0; i < qs.length; i += args.batchSize) {
      if (processed >= cap) break;
      const slice = qs
        .slice(i, i + args.batchSize)
        .slice(0, Math.max(0, cap - processed));
      if (slice.length === 0) break;
      processed += slice.length;
      const compact = slice.map((q) => ({
        id: q.id,
        stem: q.stem,
        options: q.options,
      }));
      let classifications: BatchInput[];
      try {
        classifications = await classifyBatch(client, model, ts, compact, db);
      } catch (err) {
        console.error(
          `[backfill] ${tsId} batch failed:`,
          err instanceof Error ? err.message : err,
        );
        continue;
      }

      const validIds = new Set(slice.map((q) => q.id));
      const kMax = ts.knowledgeBullets.length;
      const sMax = ts.skillsBullets.length;
      for (const c of classifications) {
        if (!validIds.has(c.question_id)) {
          invalid += 1;
          continue;
        }
        const k = (c.knowledge_bullet_idxs ?? []).filter(
          (n) => Number.isInteger(n) && n >= 0 && n < kMax,
        );
        const s = (c.skills_bullet_idxs ?? []).filter(
          (n) => Number.isInteger(n) && n >= 0 && n < sMax,
        );
        if (k.length === 0 && s.length === 0) {
          // Model emitted an empty pair — leave the row alone so the
          // missing-citations counter stays accurate and the next run can
          // retry the question with --force.
          invalid += 1;
          continue;
        }
        db.update(schema.questions)
          .set({
            knowledgeBulletIdxs: k,
            skillsBulletIdxs: s,
            updatedAt: sql`(unixepoch('subsec') * 1000)`,
          })
          .where(eq(schema.questions.id, c.question_id))
          .run();
        updated += 1;
      }
      console.log(
        `[backfill] ${tsId} batch ${i / args.batchSize + 1}: processed ${slice.length}, updated ${classifications.filter((c) => validIds.has(c.question_id)).length}`,
      );
    }
    if (processed >= cap) break;
  }

  console.log(
    `[backfill] done — processed=${processed} updated=${updated} invalid=${invalid}`,
  );
}

main().catch((err) => {
  console.error("[backfill] fatal:", err);
  process.exit(1);
});
