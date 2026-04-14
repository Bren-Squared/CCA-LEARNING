import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { and, asc, eq } from "drizzle-orm";
import { callClaude } from "../claude/client";
import { loadPromptFile } from "../claude/prompts/loader";
import {
  emitRubricInputSchema,
  emitRubricTool,
  type EmitRubricInput,
} from "../claude/roles/rubric-drafter";
import type { Db } from "../db";
import { getAppDb, schema } from "../db";

/**
 * Scenario free-response prompt catalog (FR2.4 / RD4).
 *
 * Prompts themselves are authored by hand and seeded (see
 * scripts/seed-scenario-prompts.ts). Rubrics are generated lazily: on the
 * first grade attempt against a prompt, `getOrGenerateRubric` calls the
 * `rubric-drafter` role with the prompt stem + target task statement's
 * Knowledge/Skills bullets, and persists the rubric to
 * `scenario_prompts.rubric`. Subsequent attempts reuse the cached rubric
 * verbatim (RD4 — rubric is generated once per prompt and reused for every
 * grading).
 */

export class ScenarioPromptError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "ScenarioPromptError";
  }
}

export interface RubricArtifact {
  rubric: EmitRubricInput;
  generatedAt: Date;
  cached: boolean;
}

export interface ScenarioPromptSummary {
  id: string;
  scenarioId: string;
  scenarioTitle: string;
  taskStatementId: string;
  taskStatementTitle: string;
  bloomLevel: number;
  promptText: string;
  orderIndex: number;
  hasRubric: boolean;
}

function formatBullets(bullets: string[]): string {
  return bullets.map((b) => `- ${b}`).join("\n");
}

export function getScenarioPrompt(
  promptId: string,
  db: Db = getAppDb(),
): ScenarioPromptSummary | null {
  const row = db
    .select({
      prompt: schema.scenarioPrompts,
      scenario: schema.scenarios,
      ts: schema.taskStatements,
    })
    .from(schema.scenarioPrompts)
    .innerJoin(
      schema.scenarios,
      eq(schema.scenarios.id, schema.scenarioPrompts.scenarioId),
    )
    .innerJoin(
      schema.taskStatements,
      eq(schema.taskStatements.id, schema.scenarioPrompts.taskStatementId),
    )
    .where(eq(schema.scenarioPrompts.id, promptId))
    .get();
  if (!row) return null;
  return {
    id: row.prompt.id,
    scenarioId: row.prompt.scenarioId,
    scenarioTitle: row.scenario.title,
    taskStatementId: row.prompt.taskStatementId,
    taskStatementTitle: row.ts.title,
    bloomLevel: row.prompt.bloomLevel,
    promptText: row.prompt.promptText,
    orderIndex: row.prompt.orderIndex,
    hasRubric: row.prompt.rubric !== null,
  };
}

export function listPromptsForScenario(
  scenarioId: string,
  db: Db = getAppDb(),
): ScenarioPromptSummary[] {
  const rows = db
    .select({
      prompt: schema.scenarioPrompts,
      scenario: schema.scenarios,
      ts: schema.taskStatements,
    })
    .from(schema.scenarioPrompts)
    .innerJoin(
      schema.scenarios,
      eq(schema.scenarios.id, schema.scenarioPrompts.scenarioId),
    )
    .innerJoin(
      schema.taskStatements,
      eq(schema.taskStatements.id, schema.scenarioPrompts.taskStatementId),
    )
    .where(eq(schema.scenarioPrompts.scenarioId, scenarioId))
    .orderBy(asc(schema.scenarioPrompts.orderIndex))
    .all();
  return rows.map((r) => ({
    id: r.prompt.id,
    scenarioId: r.prompt.scenarioId,
    scenarioTitle: r.scenario.title,
    taskStatementId: r.prompt.taskStatementId,
    taskStatementTitle: r.ts.title,
    bloomLevel: r.prompt.bloomLevel,
    promptText: r.prompt.promptText,
    orderIndex: r.prompt.orderIndex,
    hasRubric: r.prompt.rubric !== null,
  }));
}

export interface ScenarioWithPrompts {
  scenarioId: string;
  scenarioTitle: string;
  scenarioDescription: string;
  orderIndex: number;
  prompts: ScenarioPromptSummary[];
}

export function listAllScenariosWithPrompts(
  db: Db = getAppDb(),
): ScenarioWithPrompts[] {
  const scenarios = db
    .select()
    .from(schema.scenarios)
    .orderBy(asc(schema.scenarios.orderIndex))
    .all();
  return scenarios.map((s) => ({
    scenarioId: s.id,
    scenarioTitle: s.title,
    scenarioDescription: s.description,
    orderIndex: s.orderIndex,
    prompts: listPromptsForScenario(s.id, db),
  }));
}

/**
 * Create a scenario prompt row. Used by the seed script. Rubric is left null —
 * it's authored lazily on the first grading attempt.
 */
export function createScenarioPrompt(
  input: {
    scenarioId: string;
    taskStatementId: string;
    bloomLevel: number;
    promptText: string;
    orderIndex: number;
  },
  db: Db = getAppDb(),
): string {
  const id = randomUUID();
  db.insert(schema.scenarioPrompts)
    .values({
      id,
      scenarioId: input.scenarioId,
      taskStatementId: input.taskStatementId,
      bloomLevel: input.bloomLevel,
      promptText: input.promptText,
      orderIndex: input.orderIndex,
    })
    .run();
  return id;
}

/**
 * Upsert by (scenarioId, orderIndex) — the seed script calls this so re-runs
 * don't duplicate rows. Prompt text/task binding can be refined without
 * wiping the rubric, UNLESS the prompt text itself changes — in which case
 * we invalidate the rubric (it was drafted against the old stem).
 */
export function upsertScenarioPromptByOrder(
  input: {
    scenarioId: string;
    taskStatementId: string;
    bloomLevel: number;
    promptText: string;
    orderIndex: number;
  },
  db: Db = getAppDb(),
): { id: string; created: boolean } {
  const existing = db
    .select()
    .from(schema.scenarioPrompts)
    .where(
      and(
        eq(schema.scenarioPrompts.scenarioId, input.scenarioId),
        eq(schema.scenarioPrompts.orderIndex, input.orderIndex),
      ),
    )
    .get();
  if (existing) {
    const promptChanged = existing.promptText !== input.promptText;
    db.update(schema.scenarioPrompts)
      .set({
        taskStatementId: input.taskStatementId,
        bloomLevel: input.bloomLevel,
        promptText: input.promptText,
        ...(promptChanged
          ? { rubric: null, rubricGeneratedAt: null }
          : {}),
      })
      .where(eq(schema.scenarioPrompts.id, existing.id))
      .run();
    return { id: existing.id, created: false };
  }
  const id = createScenarioPrompt(input, db);
  return { id, created: true };
}

function extractRubricFromMessage(
  message: Awaited<ReturnType<typeof callClaude>>,
): EmitRubricInput {
  for (const block of message.content) {
    if (block.type === "tool_use" && block.name === emitRubricTool.name) {
      const parsed = emitRubricInputSchema.safeParse(block.input);
      if (!parsed.success) {
        throw new ScenarioPromptError(
          "bad_tool_output",
          `rubric-drafter returned invalid emit_rubric payload: ${parsed.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; ")}`,
        );
      }
      return parsed.data;
    }
  }
  throw new ScenarioPromptError(
    "no_tool_use",
    `rubric-drafter did not call emit_rubric (stop_reason=${message.stop_reason})`,
  );
}

/**
 * Return the rubric for a prompt, generating it via Claude on first call.
 * Pass `forceRegenerate` to rewrite the rubric — prior attempts keep the
 * grade they received (scored against the old rubric) but future attempts
 * use the new one.
 */
export async function getOrGenerateRubric(
  promptId: string,
  opts: { db?: Db; forceRegenerate?: boolean } = {},
): Promise<RubricArtifact> {
  const db = opts.db ?? getAppDb();

  const row = db
    .select({
      prompt: schema.scenarioPrompts,
      scenario: schema.scenarios,
      ts: schema.taskStatements,
    })
    .from(schema.scenarioPrompts)
    .innerJoin(
      schema.scenarios,
      eq(schema.scenarios.id, schema.scenarioPrompts.scenarioId),
    )
    .innerJoin(
      schema.taskStatements,
      eq(schema.taskStatements.id, schema.scenarioPrompts.taskStatementId),
    )
    .where(eq(schema.scenarioPrompts.id, promptId))
    .get();

  if (!row) {
    throw new ScenarioPromptError(
      "not_found",
      `scenario prompt "${promptId}" not found`,
    );
  }

  if (!opts.forceRegenerate && row.prompt.rubric && row.prompt.rubricGeneratedAt) {
    const parsed = emitRubricInputSchema.safeParse(row.prompt.rubric);
    if (parsed.success) {
      return {
        rubric: parsed.data,
        generatedAt: row.prompt.rubricGeneratedAt,
        cached: true,
      };
    }
    // Stored rubric is stale/malformed — fall through and regenerate.
  }

  const template = loadPromptFile(
    resolve(process.cwd(), "prompts/rubric-drafter.md"),
  );
  const systemPrompt = template.render({
    scenario_title: row.scenario.title,
    scenario_description: row.scenario.description,
    prompt_text: row.prompt.promptText,
    target_task_statement_id: row.ts.id,
    target_task_statement_title: row.ts.title,
    target_bloom_level: row.prompt.bloomLevel,
    knowledge_bullets: formatBullets(row.ts.knowledgeBullets),
    skills_bullets: formatBullets(row.ts.skillsBullets),
  });

  const message = await callClaude({
    role: "rubric-drafter",
    system: systemPrompt,
    cacheSystem: true,
    messages: [
      {
        role: "user",
        content: `Draft the rubric for scenario ${row.scenario.id}, prompt #${row.prompt.orderIndex + 1}, targeting ${row.ts.id} at Bloom ${row.prompt.bloomLevel}.`,
      },
    ],
    tools: [
      {
        name: emitRubricTool.name,
        description: emitRubricTool.description,
        input_schema: emitRubricTool.inputSchema,
      },
    ],
    toolChoice: { type: "tool", name: emitRubricTool.name },
    maxTokens: 2048,
    temperature: 0.3,
    db,
  });

  const rubric = extractRubricFromMessage(message);
  const now = new Date();
  db.update(schema.scenarioPrompts)
    .set({ rubric, rubricGeneratedAt: now })
    .where(eq(schema.scenarioPrompts.id, promptId))
    .run();

  return { rubric, generatedAt: now, cached: false };
}

/**
 * Read-only accessor — returns the stored rubric without calling Claude.
 * Null if the rubric hasn't been generated yet. Used by the UI to show a
 * "rubric will be authored on first grading" hint.
 */
export function readRubricCache(
  promptId: string,
  db: Db = getAppDb(),
): RubricArtifact | null {
  const row = db
    .select()
    .from(schema.scenarioPrompts)
    .where(eq(schema.scenarioPrompts.id, promptId))
    .get();
  if (!row || !row.rubric || !row.rubricGeneratedAt) return null;
  const parsed = emitRubricInputSchema.safeParse(row.rubric);
  if (!parsed.success) return null;
  return {
    rubric: parsed.data,
    generatedAt: row.rubricGeneratedAt,
    cached: true,
  };
}
