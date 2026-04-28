import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { and, eq } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";
import type { Db } from "../db";
import { getAppDb, schema } from "../db";
import { callClaude } from "../claude/client";
import { loadPromptFile } from "../claude/prompts/loader";
import { getCheapModel } from "../settings";
import {
  emitQuestionInputSchema,
  emitQuestionTool,
  type EmitQuestionInput,
} from "../claude/roles/generator";
import {
  emitReviewInputSchema,
  emitReviewTool,
  type EmitReviewInput,
} from "../claude/roles/reviewer";
import type { BloomLevel } from "../progress/mastery";

export class GeneratorError extends Error {
  readonly code: string;
  readonly detail: unknown;
  constructor(code: string, message: string, detail?: unknown) {
    super(message);
    this.code = code;
    this.detail = detail;
    this.name = "GeneratorError";
  }
}

/**
 * Max generate→review cycles per request. Attempt 1 is always made; each
 * reviewer rejection triggers one more attempt until this cap. Matches the
 * Phase 6 todo: "max 2 retries, then discard" (so 3 total attempts).
 */
export const MAX_GENERATION_ATTEMPTS = 3;

const BLOOM_VERBS: Record<number, string> = {
  1: "Remember",
  2: "Understand",
  3: "Apply",
  4: "Analyze",
  5: "Evaluate",
  6: "Create",
};

export interface GenerateParams {
  taskStatementId: string;
  bloomLevel: BloomLevel;
  scenarioId?: string;
  db?: Db;
  /** Override for tests — defaults to MAX_GENERATION_ATTEMPTS. */
  maxAttempts?: number;
}

export interface GenerateResult {
  questionId: string;
  attemptsUsed: number;
  question: EmitQuestionInput;
  reviewerSummary: string;
}

export interface AttemptLogEntry {
  attempt: number;
  verdict: "approve" | "reject";
  summary: string;
  violations: EmitReviewInput["violations"];
}

function formatBullets(bullets: string[]): string {
  return bullets.length === 0
    ? "(none)"
    : bullets.map((b) => `- ${b}`).join("\n");
}

/**
 * Phase 16 / E3 — bullets rendered with 0-based indices so the generator can
 * cite which one(s) the question tests. Uses `[i] ` prefix to match the
 * schema field shape (an array of 0-based ints).
 */
function formatBulletsIndexed(bullets: string[]): string {
  return bullets.length === 0
    ? "(none)"
    : bullets.map((b, i) => `[${i}] ${b}`).join("\n");
}

function formatFewshotBlock(seedQuestions: typeof schema.questions.$inferSelect[]): string {
  if (seedQuestions.length === 0) {
    return "## Few-shot examples\n\n(No seed questions exist for this scope — author from scratch, preserving bullet wording.)";
  }
  const rendered = seedQuestions
    .slice(0, 3)
    .map((q, i) => {
      const opts = q.options
        .map((o, j) => `  ${String.fromCharCode(65 + j)}. ${o}`)
        .join("\n");
      return `Example ${i + 1} (bloom_level=${q.bloomLevel}):\nStem: ${q.stem}\nOptions:\n${opts}\nCorrect: ${String.fromCharCode(65 + q.correctIndex)}`;
    })
    .join("\n\n");
  return `## Few-shot examples (seed-bank style reference)\n\n${rendered}`;
}

function formatScenarioBlock(
  scenario: typeof schema.scenarios.$inferSelect | null,
): string {
  if (!scenario) {
    return "**Scenario**: none for this request — author a self-contained stem.";
  }
  return `**Scenario** (${scenario.id} — ${scenario.title}):\n${scenario.description}\n\nAll questions in this scenario share this framing. Do NOT re-state the scenario in your stem — refer to it as "the scenario above" or pull specific details as needed.`;
}

function formatExistingQuestionsBlock(stems: string[]): string {
  if (stems.length === 0) return "";
  const list = stems.map((s, i) => `${i + 1}. ${s}`).join("\n");
  return `## Existing questions in this cell (DO NOT repeat)\n\nThe following ${stems.length} question${stems.length === 1 ? "" : "s"} already exist for this task statement at this Bloom level. Your new question MUST test a different angle, scenario, or concept. Do not re-use the same stem structure, situation, or core distinction.\n\n${list}`;
}

function formatRetryFeedback(log: AttemptLogEntry[]): string {
  if (log.length === 0) return "";
  const last = log[log.length - 1];
  if (last.verdict !== "reject") return "";
  const violations = last.violations
    .map((v) => `- **${v.code}**: ${v.detail}`)
    .join("\n");
  return `## Reviewer rejected your previous attempt\n\nSummary: ${last.summary}\n\nViolations:\n${violations}\n\nRewrite the question addressing every violation. Do not repeat the previous stem verbatim.`;
}

function extractToolInput<T>(
  message: Anthropic.Message,
  toolName: string,
  schemaParse: (raw: unknown) => { success: true; data: T } | { success: false; error: unknown },
  errorCode: string,
): T {
  for (const block of message.content) {
    if (block.type === "tool_use" && block.name === toolName) {
      const parsed = schemaParse(block.input);
      if (!parsed.success) {
        throw new GeneratorError(
          errorCode,
          `model returned invalid ${toolName} payload`,
          parsed.error,
        );
      }
      return parsed.data;
    }
  }
  throw new GeneratorError(
    "no_tool_use",
    `model did not call ${toolName} (stop_reason=${message.stop_reason})`,
  );
}

/**
 * Max existing stems injected into the generator prompt to steer diversity.
 * Keeps the diversity block under ~3 000 tokens even for large cells.
 */
const MAX_EXISTING_STEMS = 20;

export interface GeneratorContext {
  ts: typeof schema.taskStatements.$inferSelect;
  scenario: typeof schema.scenarios.$inferSelect | null;
  seedQuestions: typeof schema.questions.$inferSelect[];
  /** Stems of active questions already in this (task_statement, bloom_level) cell. */
  existingStems: string[];
}

export function loadGeneratorContext(
  params: { taskStatementId: string; scenarioId?: string; bloomLevel?: BloomLevel },
  db: Db,
): GeneratorContext {
  const ts = db
    .select()
    .from(schema.taskStatements)
    .where(eq(schema.taskStatements.id, params.taskStatementId))
    .get();
  if (!ts) {
    throw new GeneratorError(
      "not_found",
      `task statement "${params.taskStatementId}" not found`,
    );
  }

  const scenario = params.scenarioId
    ? (db
        .select()
        .from(schema.scenarios)
        .where(eq(schema.scenarios.id, params.scenarioId))
        .get() ?? null)
    : null;
  if (params.scenarioId && !scenario) {
    throw new GeneratorError(
      "not_found",
      `scenario "${params.scenarioId}" not found`,
    );
  }

  const seedQuestions = scenario
    ? db
        .select()
        .from(schema.questions)
        .where(
          and(
            eq(schema.questions.scenarioId, scenario.id),
            eq(schema.questions.source, "seed"),
          ),
        )
        .all()
    : db
        .select()
        .from(schema.questions)
        .where(
          and(
            eq(schema.questions.taskStatementId, ts.id),
            eq(schema.questions.source, "seed"),
          ),
        )
        .all();

  // When bloomLevel is provided, fetch active stems for this cell so the
  // generator can avoid repeating existing questions.
  let existingStems: string[] = [];
  if (params.bloomLevel) {
    const rows = db
      .select({ stem: schema.questions.stem })
      .from(schema.questions)
      .where(
        and(
          eq(schema.questions.taskStatementId, ts.id),
          eq(schema.questions.bloomLevel, params.bloomLevel),
          eq(schema.questions.status, "active"),
        ),
      )
      .limit(MAX_EXISTING_STEMS)
      .all();
    existingStems = rows.map((r) => r.stem);
  }

  return { ts, scenario, seedQuestions, existingStems };
}

export function buildGeneratorSystemPrompt(
  ctx: GeneratorContext,
  bloomLevel: BloomLevel,
  retryLog: AttemptLogEntry[],
): string {
  const { ts, scenario, seedQuestions, existingStems } = ctx;
  const promptPath = resolve(process.cwd(), "prompts/generator.md");
  const template = loadPromptFile(promptPath);
  return template.render({
    task_statement_id: ts.id,
    task_statement_title: ts.title,
    domain_id: ts.domainId,
    knowledge_bullets_indexed: formatBulletsIndexed(ts.knowledgeBullets),
    skills_bullets_indexed: formatBulletsIndexed(ts.skillsBullets),
    target_bloom_level: bloomLevel,
    target_bloom_verb: BLOOM_VERBS[bloomLevel] ?? String(bloomLevel),
    scenario_block: formatScenarioBlock(scenario),
    fewshot_block: formatFewshotBlock(seedQuestions),
    existing_questions_block: formatExistingQuestionsBlock(existingStems),
    retry_feedback: formatRetryFeedback(retryLog),
  });
}

/**
 * Phase 16 / E3 — validates a candidate's `knowledge_bullet_idxs` and
 * `skills_bullet_idxs` against the parent task statement's bullet counts.
 * Returns null when valid, or a violation entry the orchestrator can feed
 * into `retryLog` so the next attempt sees the specific issue.
 */
export function validateBulletIdxs(
  candidate: Pick<EmitQuestionInput, "knowledge_bullet_idxs" | "skills_bullet_idxs">,
  ts: typeof schema.taskStatements.$inferSelect,
): { code: "out_of_range" | "empty"; detail: string } | null {
  const k = candidate.knowledge_bullet_idxs ?? [];
  const s = candidate.skills_bullet_idxs ?? [];
  if (k.length === 0 && s.length === 0) {
    return {
      code: "empty",
      detail:
        "no bullet citations — at least one of knowledge_bullet_idxs or skills_bullet_idxs must be non-empty",
    };
  }
  const kMax = ts.knowledgeBullets.length;
  const sMax = ts.skillsBullets.length;
  for (const idx of k) {
    if (idx < 0 || idx >= kMax) {
      return {
        code: "out_of_range",
        detail: `knowledge_bullet_idxs contains ${idx} but task statement has only ${kMax} knowledge bullets (valid: 0..${kMax - 1})`,
      };
    }
  }
  for (const idx of s) {
    if (idx < 0 || idx >= sMax) {
      return {
        code: "out_of_range",
        detail: `skills_bullet_idxs contains ${idx} but task statement has only ${sMax} skills bullets (valid: 0..${sMax - 1})`,
      };
    }
  }
  return null;
}

export const GENERATOR_TOOL_PARAMS = {
  tools: [
    {
      name: emitQuestionTool.name,
      description: emitQuestionTool.description,
      input_schema: emitQuestionTool.inputSchema,
    },
  ] satisfies Anthropic.Tool[],
  toolChoice: {
    type: "tool" as const,
    name: emitQuestionTool.name,
  },
  maxTokens: 2048,
  temperature: 0.4,
};

async function callGenerator(
  ctx: GeneratorContext,
  bloomLevel: BloomLevel,
  retryLog: AttemptLogEntry[],
  db: Db,
): Promise<EmitQuestionInput> {
  const systemPrompt = buildGeneratorSystemPrompt(ctx, bloomLevel, retryLog);

  const message = await callClaude({
    role: "generator",
    system: systemPrompt,
    cacheSystem: true,
    messages: [
      {
        role: "user",
        content: `Author ONE new MCQ for task statement ${ctx.ts.id} at Bloom level ${bloomLevel}${ctx.scenario ? ` anchored to scenario ${ctx.scenario.id}` : ""}.`,
      },
    ],
    tools: GENERATOR_TOOL_PARAMS.tools,
    toolChoice: GENERATOR_TOOL_PARAMS.toolChoice,
    maxTokens: GENERATOR_TOOL_PARAMS.maxTokens,
    temperature: GENERATOR_TOOL_PARAMS.temperature,
    db,
  });

  return parseGeneratorMessage(message);
}

export function parseGeneratorMessage(
  message: Anthropic.Message,
): EmitQuestionInput {
  return extractToolInput(
    message,
    emitQuestionTool.name,
    (raw) => {
      const res = emitQuestionInputSchema.safeParse(raw);
      return res.success
        ? { success: true, data: res.data }
        : { success: false, error: res.error };
    },
    "bad_generator_output",
  );
}

export async function callReviewer(
  ts: typeof schema.taskStatements.$inferSelect,
  bloomLevel: BloomLevel,
  candidate: EmitQuestionInput,
  db: Db,
): Promise<EmitReviewInput> {
  const promptPath = resolve(process.cwd(), "prompts/reviewer.md");
  const template = loadPromptFile(promptPath);
  const systemPrompt = template.render({
    task_statement_id: ts.id,
    task_statement_title: ts.title,
    knowledge_bullets: formatBullets(ts.knowledgeBullets),
    skills_bullets: formatBullets(ts.skillsBullets),
    target_bloom_level: bloomLevel,
    candidate_json: JSON.stringify(candidate, null, 2),
  });

  const message = await callClaude({
    role: "reviewer",
    model: getCheapModel(db),
    system: systemPrompt,
    cacheSystem: false,
    messages: [
      {
        role: "user",
        content: `Review the candidate MCQ above. Issue an approve/reject verdict via emit_review.`,
      },
    ],
    tools: [
      {
        name: emitReviewTool.name,
        description: emitReviewTool.description,
        input_schema: emitReviewTool.inputSchema,
      },
    ],
    toolChoice: { type: "tool", name: emitReviewTool.name },
    maxTokens: 1024,
    temperature: 0,
    db,
  });

  return extractToolInput(
    message,
    emitReviewTool.name,
    (raw) => {
      const res = emitReviewInputSchema.safeParse(raw);
      return res.success
        ? { success: true, data: res.data }
        : { success: false, error: res.error };
    },
    "bad_reviewer_output",
  );
}

export function persistApprovedQuestion(
  ts: typeof schema.taskStatements.$inferSelect,
  scenarioId: string | null,
  candidate: EmitQuestionInput,
  db: Db,
): string {
  const id = randomUUID();
  db.insert(schema.questions)
    .values({
      id,
      stem: candidate.stem,
      options: candidate.options,
      correctIndex: candidate.correct_index,
      explanations: candidate.explanations,
      taskStatementId: ts.id,
      scenarioId,
      difficulty: candidate.difficulty,
      bloomLevel: candidate.bloom_level,
      bloomJustification: candidate.bloom_justification,
      knowledgeBulletIdxs: candidate.knowledge_bullet_idxs ?? [],
      skillsBulletIdxs: candidate.skills_bullet_idxs ?? [],
      source: "generated",
      status: "active",
    })
    .run();
  return id;
}

/**
 * Generate one MCQ through the full generator → reviewer → retry pipeline.
 * Reviewer independence is enforced by issuing a fresh Claude call on the
 * cheap tier with no shared context. After `maxAttempts` rejections, throws
 * `GeneratorError("exhausted", ...)` carrying the last verdict for the UI
 * to surface — the candidate is NOT persisted.
 */
export async function generateOneQuestion(
  params: GenerateParams,
): Promise<GenerateResult> {
  const db = params.db ?? getAppDb();
  const maxAttempts = params.maxAttempts ?? MAX_GENERATION_ATTEMPTS;

  const ctx = loadGeneratorContext(
    {
      taskStatementId: params.taskStatementId,
      scenarioId: params.scenarioId,
      bloomLevel: params.bloomLevel,
    },
    db,
  );

  const log: AttemptLogEntry[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const candidate = await callGenerator(ctx, params.bloomLevel, log, db);

    // Phase 16 / E3 — bullet-citation validation runs BEFORE the reviewer.
    // Out-of-range indices are a structural violation we can detect locally
    // (no Claude call) and feed back to the next attempt with a precise
    // bullet-count message — cheaper and more actionable than letting the
    // reviewer guess that the citations are wrong.
    const bulletViolation = validateBulletIdxs(candidate, ctx.ts);
    if (bulletViolation) {
      log.push({
        attempt,
        verdict: "reject",
        summary: `bullet citation invalid (${bulletViolation.code})`,
        violations: [
          {
            // Reviewer's enum doesn't have a bullet-citation code; reuse
            // `fabricated_content` since an out-of-range index implies the
            // model invented a bullet that doesn't exist on the TS.
            code: "fabricated_content",
            detail: bulletViolation.detail,
          },
        ],
      });
      continue;
    }

    const review = await callReviewer(ctx.ts, params.bloomLevel, candidate, db);
    log.push({
      attempt,
      verdict: review.verdict,
      summary: review.summary,
      violations: review.violations,
    });
    if (review.verdict === "approve") {
      const questionId = persistApprovedQuestion(
        ctx.ts,
        ctx.scenario?.id ?? null,
        candidate,
        db,
      );
      return {
        questionId,
        attemptsUsed: attempt,
        question: candidate,
        reviewerSummary: review.summary,
      };
    }
  }

  const last = log[log.length - 1];
  throw new GeneratorError(
    "exhausted",
    `reviewer rejected every attempt (${maxAttempts}). Last summary: ${last.summary}`,
    { log },
  );
}
