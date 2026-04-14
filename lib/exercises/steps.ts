import { resolve } from "node:path";
import { asc, eq, inArray } from "drizzle-orm";
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
 * Preparation-exercise step catalog (FR2.7 / D1.4).
 *
 * Exercises and their steps are seeded by the ingester from the exam guide.
 * Each step has a prompt describing the artifact the candidate must produce;
 * rubrics are generated lazily on the first grading attempt against that
 * step (same lifecycle as scenario prompts — RD4 pattern). Steps persist
 * their rubric via `preparation_steps.rubric` so every subsequent grading of
 * the same step scores against the identical anchors.
 */

export class ExerciseError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "ExerciseError";
  }
}

export interface ExerciseSummary {
  id: string;
  title: string;
  description: string;
  domainsReinforced: string[];
  orderIndex: number;
  stepCount: number;
}

export interface ExerciseStepSummary {
  id: string;
  exerciseId: string;
  stepIdx: number;
  prompt: string;
  hasRubric: boolean;
}

export interface ExerciseDetail extends ExerciseSummary {
  steps: ExerciseStepSummary[];
}

export interface RubricArtifact {
  rubric: EmitRubricInput;
  generatedAt: Date;
  cached: boolean;
}

function toStepSummary(
  row: typeof schema.preparationSteps.$inferSelect,
): ExerciseStepSummary {
  return {
    id: row.id,
    exerciseId: row.exerciseId,
    stepIdx: row.stepIdx,
    prompt: row.prompt,
    hasRubric: row.rubric !== null && row.rubricGeneratedAt !== null,
  };
}

export function listExercises(db: Db = getAppDb()): ExerciseSummary[] {
  const exercises = db
    .select()
    .from(schema.preparationExercises)
    .orderBy(asc(schema.preparationExercises.orderIndex))
    .all();
  const stepRows = db
    .select({
      exerciseId: schema.preparationSteps.exerciseId,
      id: schema.preparationSteps.id,
    })
    .from(schema.preparationSteps)
    .all();
  const stepCounts = new Map<string, number>();
  for (const r of stepRows) {
    stepCounts.set(r.exerciseId, (stepCounts.get(r.exerciseId) ?? 0) + 1);
  }
  return exercises.map((e) => ({
    id: e.id,
    title: e.title,
    description: e.description,
    domainsReinforced: e.domainsReinforced,
    orderIndex: e.orderIndex,
    stepCount: stepCounts.get(e.id) ?? 0,
  }));
}

export function getExercise(
  exerciseId: string,
  db: Db = getAppDb(),
): ExerciseDetail | null {
  const exercise = db
    .select()
    .from(schema.preparationExercises)
    .where(eq(schema.preparationExercises.id, exerciseId))
    .get();
  if (!exercise) return null;
  const steps = db
    .select()
    .from(schema.preparationSteps)
    .where(eq(schema.preparationSteps.exerciseId, exerciseId))
    .orderBy(asc(schema.preparationSteps.stepIdx))
    .all();
  return {
    id: exercise.id,
    title: exercise.title,
    description: exercise.description,
    domainsReinforced: exercise.domainsReinforced,
    orderIndex: exercise.orderIndex,
    stepCount: steps.length,
    steps: steps.map(toStepSummary),
  };
}

export function getStep(
  stepId: string,
  db: Db = getAppDb(),
): ExerciseStepSummary | null {
  const row = db
    .select()
    .from(schema.preparationSteps)
    .where(eq(schema.preparationSteps.id, stepId))
    .get();
  return row ? toStepSummary(row) : null;
}

/**
 * Expand a `domains_reinforced` entry into concrete task statement IDs.
 * The exam guide lists either a bare domain (`D1`) — meaning the exercise
 * exercises every task statement under that domain — or a specific task
 * statement (`D1.4`). We accept both so the ingester can grow more precise
 * metadata over time without requiring a schema change.
 */
export function resolveReinforcedTaskStatements(
  domainsReinforced: string[],
  db: Db = getAppDb(),
): string[] {
  const domains: string[] = [];
  const explicit: string[] = [];
  for (const entry of domainsReinforced) {
    if (entry.includes(".")) explicit.push(entry);
    else domains.push(entry);
  }
  let fromDomains: string[] = [];
  if (domains.length > 0) {
    const rows = db
      .select({ id: schema.taskStatements.id })
      .from(schema.taskStatements)
      .where(inArray(schema.taskStatements.domainId, domains))
      .all();
    fromDomains = rows.map((r) => r.id);
  }
  // De-dupe while preserving order (domain-expanded first, then explicit).
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of [...fromDomains, ...explicit]) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

function formatBullets(label: string, bullets: string[]): string {
  if (bullets.length === 0) return "";
  return `${label}:\n${bullets.map((b) => `  - ${b}`).join("\n")}`;
}

function extractRubricFromMessage(
  message: Awaited<ReturnType<typeof callClaude>>,
): EmitRubricInput {
  for (const block of message.content) {
    if (block.type === "tool_use" && block.name === emitRubricTool.name) {
      const parsed = emitRubricInputSchema.safeParse(block.input);
      if (!parsed.success) {
        throw new ExerciseError(
          "bad_tool_output",
          `rubric-drafter returned invalid emit_rubric payload: ${parsed.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; ")}`,
        );
      }
      return parsed.data;
    }
  }
  throw new ExerciseError(
    "no_tool_use",
    `rubric-drafter did not call emit_rubric (stop_reason=${message.stop_reason})`,
  );
}

/**
 * Return the rubric for a step, generating it via Claude on first call.
 * `forceRegenerate` ignores the cache and rewrites the stored rubric —
 * previously-graded attempts keep the scores they received (graded against
 * the old rubric) but future attempts use the new one.
 */
export async function getOrGenerateStepRubric(
  stepId: string,
  opts: { db?: Db; forceRegenerate?: boolean } = {},
): Promise<RubricArtifact> {
  const db = opts.db ?? getAppDb();

  const row = db
    .select({
      step: schema.preparationSteps,
      exercise: schema.preparationExercises,
    })
    .from(schema.preparationSteps)
    .innerJoin(
      schema.preparationExercises,
      eq(schema.preparationExercises.id, schema.preparationSteps.exerciseId),
    )
    .where(eq(schema.preparationSteps.id, stepId))
    .get();

  if (!row) {
    throw new ExerciseError("not_found", `preparation step "${stepId}" not found`);
  }

  if (
    !opts.forceRegenerate &&
    row.step.rubric &&
    row.step.rubricGeneratedAt
  ) {
    const parsed = emitRubricInputSchema.safeParse(row.step.rubric);
    if (parsed.success) {
      return {
        rubric: parsed.data,
        generatedAt: row.step.rubricGeneratedAt,
        cached: true,
      };
    }
    // Stored rubric is stale/malformed — fall through and regenerate.
  }

  const stepTotal = db
    .select({ id: schema.preparationSteps.id })
    .from(schema.preparationSteps)
    .where(eq(schema.preparationSteps.exerciseId, row.exercise.id))
    .all().length;

  const reinforcedIds = resolveReinforcedTaskStatements(
    row.exercise.domainsReinforced,
    db,
  );
  const reinforcedTs = db
    .select()
    .from(schema.taskStatements)
    .where(inArray(schema.taskStatements.id, reinforcedIds))
    .all();
  const reinforcedBullets = reinforcedTs
    .map((ts) =>
      [
        `### ${ts.id} — ${ts.title}`,
        formatBullets("Knowledge", ts.knowledgeBullets),
        formatBullets("Skills", ts.skillsBullets),
      ]
        .filter((s) => s.length > 0)
        .join("\n"),
    )
    .join("\n\n");

  const template = loadPromptFile(
    resolve(process.cwd(), "prompts/exercise-rubric-drafter.md"),
  );
  const systemPrompt = template.render({
    exercise_title: row.exercise.title,
    exercise_description: row.exercise.description,
    exercise_domains_reinforced: row.exercise.domainsReinforced.join(", "),
    step_idx: row.step.stepIdx,
    step_total: stepTotal,
    step_prompt: row.step.prompt,
    reinforced_bullets: reinforcedBullets,
  });

  const message = await callClaude({
    role: "rubric-drafter",
    system: systemPrompt,
    cacheSystem: true,
    messages: [
      {
        role: "user",
        content: `Draft the rubric for exercise ${row.exercise.id}, step ${row.step.stepIdx + 1} of ${stepTotal}.`,
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
  db.update(schema.preparationSteps)
    .set({ rubric, rubricGeneratedAt: now })
    .where(eq(schema.preparationSteps.id, stepId))
    .run();

  return { rubric, generatedAt: now, cached: false };
}

export function readStepRubricCache(
  stepId: string,
  db: Db = getAppDb(),
): RubricArtifact | null {
  const row = db
    .select()
    .from(schema.preparationSteps)
    .where(eq(schema.preparationSteps.id, stepId))
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

/**
 * Load the latest attempt for each step ordered by step_idx, up to
 * `beforeStepIdx` (exclusive). Used by the grader to hand the model the
 * candidate's prior artifacts as context for D1.4 multi-step handoff —
 * step N's grade depends on what the candidate produced in steps 0..N-1.
 */
export function loadPriorStepArtifacts(
  exerciseId: string,
  beforeStepIdx: number,
  db: Db = getAppDb(),
): Array<{
  stepId: string;
  stepIdx: number;
  prompt: string;
  artifactText: string;
  grade: number | null;
}> {
  const rows = db
    .select({
      step: schema.preparationSteps,
      attempt: schema.preparationAttempts,
    })
    .from(schema.preparationSteps)
    .innerJoin(
      schema.preparationAttempts,
      eq(schema.preparationAttempts.stepId, schema.preparationSteps.id),
    )
    .where(eq(schema.preparationSteps.exerciseId, exerciseId))
    .all();

  const latestByStep = new Map<
    string,
    { stepIdx: number; prompt: string; artifactText: string; grade: number | null; ts: number }
  >();
  for (const row of rows) {
    if (row.step.stepIdx >= beforeStepIdx) continue;
    const prev = latestByStep.get(row.step.id);
    const tsMs = row.attempt.ts.getTime();
    if (!prev || prev.ts < tsMs) {
      latestByStep.set(row.step.id, {
        stepIdx: row.step.stepIdx,
        prompt: row.step.prompt,
        artifactText: row.attempt.artifactText,
        grade: row.attempt.grade,
        ts: tsMs,
      });
    }
  }
  return [...latestByStep.entries()]
    .map(([stepId, v]) => ({
      stepId,
      stepIdx: v.stepIdx,
      prompt: v.prompt,
      artifactText: v.artifactText,
      grade: v.grade,
    }))
    .sort((a, b) => a.stepIdx - b.stepIdx);
}
