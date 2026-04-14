import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { asc, eq } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";
import { callClaude } from "../claude/client";
import { loadPromptFile } from "../claude/prompts/loader";
import {
  recordGradeInputSchema,
  recordGradeTool,
  type RecordGradeInput,
} from "../claude/roles/grader";
import type { Db } from "../db";
import { getAppDb, schema } from "../db";
import { refreshSnapshot } from "../progress/events";
import type { BloomLevel } from "../progress/mastery";
import { readSettings } from "../settings";
import {
  ExerciseError,
  getOrGenerateStepRubric,
  loadPriorStepArtifacts,
  resolveReinforcedTaskStatements,
} from "./steps";

/**
 * Preparation-exercise step grader (FR2.7 / AT16).
 *
 * `gradeExerciseStep(stepId, artifactText)` runs in an isolated Claude
 * context. The system prompt contains ONLY:
 *   - the exercise metadata (title/description/domains_reinforced),
 *   - the step prompt currently being graded,
 *   - the rubric for THIS step,
 *   - the candidate's prior-step artifacts (D1.4 multi-step handoff),
 *   - the candidate's artifact for this step.
 *
 * It sees no tutor transcript, no mastery state, no other study events. The
 * only tool offered is `record_grade` with `tool_choice` forced — one legal
 * exit, exactly like the scenario grader (AT17 pattern).
 *
 * A successful grade (overall_score ≥ 3.0) writes one `exercise_step_grade`
 * progress event at Bloom level 6 (Create) for EACH task statement in the
 * exercise's `domains_reinforced` set. The idea is that a Create-level
 * artifact demonstrates command of multiple domains simultaneously, so
 * mastery contribution fans out across them.
 */

const EXERCISE_CREATE_LEVEL = 6 as BloomLevel;
const SUCCESS_THRESHOLD = 3.0;
const MIN_ARTIFACT_CHARS = 20;
const MAX_ARTIFACT_CHARS = 20_000;

export class ExerciseGradeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "ExerciseGradeError";
  }
}

export interface ExerciseGradeResult {
  attemptId: string;
  stepId: string;
  exerciseId: string;
  overallScore: number;
  success: boolean;
  perCriterion: RecordGradeInput["per_criterion"];
  strengths: string[];
  gaps: string[];
  modelAnswer: string;
  rubric: Awaited<ReturnType<typeof getOrGenerateStepRubric>>["rubric"];
  reinforcedTaskStatementIds: string[];
  eventIds: string[];
  /** Per-TS Bloom-6 mastery scores after writing this attempt's events. */
  masterySnapshots: Array<{ taskStatementId: string; score: number; itemCount: number }>;
}

export interface GraderCallInspector {
  systemPrompt: string;
  tools: Anthropic.Tool[];
  messages: Anthropic.MessageParam[];
  toolChoice: Anthropic.ToolChoice | undefined;
}

export interface GradeExerciseStepOpts {
  db?: Db;
  now?: Date;
  /** Receive the exact Claude request payload — test hook for isolation assertions. */
  onGraderCall?: (inspector: GraderCallInspector) => void;
}

function extractGradeFromMessage(
  message: Awaited<ReturnType<typeof callClaude>>,
): RecordGradeInput {
  for (const block of message.content) {
    if (block.type === "tool_use" && block.name === recordGradeTool.name) {
      const parsed = recordGradeInputSchema.safeParse(block.input);
      if (!parsed.success) {
        throw new ExerciseGradeError(
          "bad_tool_output",
          `grader returned invalid record_grade payload: ${parsed.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; ")}`,
        );
      }
      return parsed.data;
    }
  }
  throw new ExerciseGradeError(
    "no_tool_use",
    `grader did not call record_grade (stop_reason=${message.stop_reason})`,
  );
}

function formatPriorArtifacts(
  prior: ReturnType<typeof loadPriorStepArtifacts>,
): string {
  if (prior.length === 0) {
    return "(None — this is the first step being graded.)";
  }
  return prior
    .map((p) => {
      const gradeNote =
        p.grade !== null ? ` (previously graded ${p.grade.toFixed(1)}/5)` : "";
      return `### Step ${p.stepIdx + 1}${gradeNote}\nPrompt: ${p.prompt}\n\nArtifact:\n${p.artifactText}`;
    })
    .join("\n\n---\n\n");
}

export async function gradeExerciseStep(
  stepId: string,
  artifactText: string,
  opts: GradeExerciseStepOpts = {},
): Promise<ExerciseGradeResult> {
  const db = opts.db ?? getAppDb();
  const now = opts.now ?? new Date();

  const trimmed = artifactText.trim();
  if (trimmed.length < MIN_ARTIFACT_CHARS) {
    throw new ExerciseGradeError(
      "artifact_too_short",
      `artifact must be at least ${MIN_ARTIFACT_CHARS} characters — not enough to grade meaningfully`,
    );
  }
  if (trimmed.length > MAX_ARTIFACT_CHARS) {
    throw new ExerciseGradeError(
      "artifact_too_long",
      `artifact exceeds ${MAX_ARTIFACT_CHARS} characters — trim before submitting`,
    );
  }

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

  const stepTotal = db
    .select({ id: schema.preparationSteps.id })
    .from(schema.preparationSteps)
    .where(eq(schema.preparationSteps.exerciseId, row.exercise.id))
    .orderBy(asc(schema.preparationSteps.stepIdx))
    .all().length;

  // Generate the rubric lazily (FR2.7 lazy rubric). The rubric-drafter call
  // is a SEPARATE API call from the grading call; both are isolated from each
  // other and from any tutor state.
  const { rubric } = await getOrGenerateStepRubric(stepId, { db });

  const priorArtifacts = loadPriorStepArtifacts(
    row.exercise.id,
    row.step.stepIdx,
    db,
  );

  const template = loadPromptFile(
    resolve(process.cwd(), "prompts/exercise-grader.md"),
  );
  const systemPrompt = template.render({
    exercise_title: row.exercise.title,
    exercise_description: row.exercise.description,
    exercise_domains_reinforced: row.exercise.domainsReinforced.join(", "),
    step_idx: row.step.stepIdx,
    step_total: stepTotal,
    step_prompt: row.step.prompt,
    rubric_json: JSON.stringify(rubric, null, 2),
    prior_artifacts: formatPriorArtifacts(priorArtifacts),
    candidate_artifact: trimmed,
  });

  const tools: Anthropic.Tool[] = [
    {
      name: recordGradeTool.name,
      description: recordGradeTool.description,
      input_schema: recordGradeTool.inputSchema,
    },
  ];
  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: `Grade the artifact for exercise ${row.exercise.id}, step ${row.step.stepIdx + 1} of ${stepTotal}. Apply the rubric above verbatim and emit a single record_grade call.`,
    },
  ];
  const toolChoice: Anthropic.ToolChoice = {
    type: "tool",
    name: recordGradeTool.name,
  };

  opts.onGraderCall?.({ systemPrompt, tools, messages, toolChoice });

  const message = await callClaude({
    role: "grader",
    system: systemPrompt,
    cacheSystem: false,
    messages,
    tools,
    toolChoice,
    maxTokens: 3072,
    temperature: 0.2,
    db,
  });

  const grade = extractGradeFromMessage(message);
  const success = grade.overall_score >= SUCCESS_THRESHOLD;
  const reinforcedIds = resolveReinforcedTaskStatements(
    row.exercise.domainsReinforced,
    db,
  );
  if (reinforcedIds.length === 0) {
    throw new ExerciseGradeError(
      "no_reinforced_task_statements",
      `exercise ${row.exercise.id} has no resolvable task statements in its domains_reinforced set`,
    );
  }
  const halfLifeDays = readSettings(db).reviewHalfLifeDays;

  return db.transaction((tx) => {
    const eventIds: string[] = [];
    const masterySnapshots: ExerciseGradeResult["masterySnapshots"] = [];

    // Fan out one Create-level event per reinforced TS. A Create-level
    // artifact simultaneously exercises every TS in the exercise's domains.
    for (const tsId of reinforcedIds) {
      const eventId = randomUUID();
      tx.insert(schema.progressEvents)
        .values({
          id: eventId,
          ts: now,
          kind: "exercise_step_grade",
          taskStatementId: tsId,
          bloomLevel: EXERCISE_CREATE_LEVEL,
          success,
          payload: {
            exerciseId: row.exercise.id,
            stepId,
            stepIdx: row.step.stepIdx,
            overallScore: grade.overall_score,
          },
        })
        .run();
      eventIds.push(eventId);

      const { score, itemCount } = refreshSnapshot(
        tsId,
        EXERCISE_CREATE_LEVEL,
        { now: now.getTime(), halfLifeDays },
        tx,
      );
      masterySnapshots.push({ taskStatementId: tsId, score, itemCount });
    }

    const attemptId = randomUUID();
    tx.insert(schema.preparationAttempts)
      .values({
        id: attemptId,
        stepId,
        artifactText: trimmed,
        grade: grade.overall_score,
        feedback: {
          perCriterion: grade.per_criterion,
          strengths: grade.strengths,
          gaps: grade.gaps,
          modelAnswer: grade.model_answer,
          reinforcedTaskStatementIds: reinforcedIds,
          eventIds,
          success,
        },
        ts: now,
      })
      .run();

    return {
      attemptId,
      stepId,
      exerciseId: row.exercise.id,
      overallScore: grade.overall_score,
      success,
      perCriterion: grade.per_criterion,
      strengths: grade.strengths,
      gaps: grade.gaps,
      modelAnswer: grade.model_answer,
      rubric,
      reinforcedTaskStatementIds: reinforcedIds,
      eventIds,
      masterySnapshots,
    };
  });
}

export interface ExerciseAttemptSummary {
  id: string;
  stepId: string;
  grade: number | null;
  createdAt: Date;
  strengths: string[];
  gaps: string[];
  modelAnswer: string;
  perCriterion: RecordGradeInput["per_criterion"];
}

export function listAttemptsForStep(
  stepId: string,
  db: Db = getAppDb(),
): ExerciseAttemptSummary[] {
  const rows = db
    .select()
    .from(schema.preparationAttempts)
    .where(eq(schema.preparationAttempts.stepId, stepId))
    .all();
  return rows
    .map((r) => {
      const fb = (r.feedback ?? {}) as {
        perCriterion?: RecordGradeInput["per_criterion"];
        strengths?: string[];
        gaps?: string[];
        modelAnswer?: string;
      };
      return {
        id: r.id,
        stepId: r.stepId,
        grade: r.grade,
        createdAt: r.ts,
        strengths: fb.strengths ?? [],
        gaps: fb.gaps ?? [],
        modelAnswer: fb.modelAnswer ?? "",
        perCriterion: fb.perCriterion ?? [],
      };
    })
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

export function getLatestAttemptForStep(
  stepId: string,
  db: Db = getAppDb(),
): ExerciseAttemptSummary | null {
  return listAttemptsForStep(stepId, db)[0] ?? null;
}
