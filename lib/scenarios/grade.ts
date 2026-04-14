import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
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
import { getOrGenerateRubric, ScenarioPromptError } from "./prompts";

/**
 * Scenario free-response grader (FR2.4 / AT17).
 *
 * `gradeScenarioAttempt(promptId, answerText)` runs in an isolated Claude
 * context: the system prompt contains ONLY the scenario description, prompt
 * stem, target task statement, rubric, and user answer. There is no tutor
 * transcript, no progress events, no other study state. The model is
 * offered exactly one tool — `record_grade` — with `tool_choice` forced to
 * it, so the API call has a single legal exit: emit one grade.
 *
 * Mastery contribution: an attempt is `success=true` when overall_score
 * ≥ 3.0 (the rubric's "partial" anchor), logged as a `scenario_grade`
 * progress event at the prompt's target Bloom level.
 */

export class ScenarioGradeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "ScenarioGradeError";
  }
}

const SUCCESS_THRESHOLD = 3.0;

export interface ScenarioGradeResult {
  attemptId: string;
  promptId: string;
  overallScore: number;
  success: boolean;
  perCriterion: RecordGradeInput["per_criterion"];
  strengths: string[];
  gaps: string[];
  modelAnswer: string;
  rubric: Awaited<ReturnType<typeof getOrGenerateRubric>>["rubric"];
  eventId: string;
  masteryScore: number;
  masteryItemCount: number;
}

/**
 * Optional inspector — tests pin AT17 (isolated grader call) by capturing
 * the exact Claude request that went out. The inspector is a side channel
 * that does NOT affect the grading result itself.
 */
export interface GraderCallInspector {
  systemPrompt: string;
  tools: Anthropic.Tool[];
  messages: Anthropic.MessageParam[];
  toolChoice: Anthropic.ToolChoice | undefined;
}

function extractGradeFromMessage(
  message: Awaited<ReturnType<typeof callClaude>>,
): RecordGradeInput {
  for (const block of message.content) {
    if (block.type === "tool_use" && block.name === recordGradeTool.name) {
      const parsed = recordGradeInputSchema.safeParse(block.input);
      if (!parsed.success) {
        throw new ScenarioGradeError(
          "bad_tool_output",
          `grader returned invalid record_grade payload: ${parsed.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; ")}`,
        );
      }
      return parsed.data;
    }
  }
  throw new ScenarioGradeError(
    "no_tool_use",
    `grader did not call record_grade (stop_reason=${message.stop_reason})`,
  );
}

export interface GradeScenarioOpts {
  db?: Db;
  now?: Date;
  /** Receive the exact Claude request payload — AT17 test hook. */
  onGraderCall?: (inspector: GraderCallInspector) => void;
}

export async function gradeScenarioAttempt(
  promptId: string,
  answerText: string,
  opts: GradeScenarioOpts = {},
): Promise<ScenarioGradeResult> {
  const db = opts.db ?? getAppDb();
  const now = opts.now ?? new Date();

  const trimmed = answerText.trim();
  if (trimmed.length < 20) {
    throw new ScenarioGradeError(
      "answer_too_short",
      "answer must be at least 20 characters — not enough text to grade meaningfully",
    );
  }
  if (trimmed.length > 20_000) {
    throw new ScenarioGradeError(
      "answer_too_long",
      "answer exceeds 20,000 characters — trim before submitting",
    );
  }

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

  // Generate the rubric lazily if needed — RD4. The rubric-drafter call is
  // a SEPARATE API call from the grading call; both are isolated from each
  // other and from any tutor state.
  const { rubric } = await getOrGenerateRubric(promptId, { db });

  const template = loadPromptFile(
    resolve(process.cwd(), "prompts/grader.md"),
  );
  const systemPrompt = template.render({
    scenario_title: row.scenario.title,
    scenario_description: row.scenario.description,
    prompt_text: row.prompt.promptText,
    target_task_statement_id: row.ts.id,
    target_task_statement_title: row.ts.title,
    target_bloom_level: row.prompt.bloomLevel,
    rubric_json: JSON.stringify(rubric, null, 2),
    user_answer: trimmed,
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
      content: `Grade the candidate answer for prompt ${row.prompt.id} (scenario ${row.scenario.id}, target ${row.ts.id} at Bloom ${row.prompt.bloomLevel}). Apply the rubric above verbatim and emit a single record_grade call.`,
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
    // cacheSystem stays false — each grading has a unique user answer in
    // the system prompt, so the cache would miss anyway, and the grader is
    // configured this way in roles/grader.ts.
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
  const bloomLevel = row.prompt.bloomLevel as BloomLevel;
  const halfLifeDays = readSettings(db).reviewHalfLifeDays;

  return db.transaction((tx) => {
    const eventId = randomUUID();
    tx.insert(schema.progressEvents)
      .values({
        id: eventId,
        ts: now,
        kind: "scenario_grade",
        taskStatementId: row.ts.id,
        bloomLevel,
        success,
        payload: {
          promptId,
          scenarioId: row.scenario.id,
          overallScore: grade.overall_score,
          perCriterion: grade.per_criterion,
        },
      })
      .run();

    const { score, itemCount } = refreshSnapshot(
      row.ts.id,
      bloomLevel,
      { now: now.getTime(), halfLifeDays },
      tx,
    );

    const attemptId = randomUUID();
    tx.insert(schema.scenarioAttempts)
      .values({
        id: attemptId,
        promptId,
        answerText: trimmed,
        overallScore: grade.overall_score,
        feedback: {
          perCriterion: grade.per_criterion,
          strengths: grade.strengths,
          gaps: grade.gaps,
          modelAnswer: grade.model_answer,
        },
        progressEventId: eventId,
      })
      .run();

    return {
      attemptId,
      promptId,
      overallScore: grade.overall_score,
      success,
      perCriterion: grade.per_criterion,
      strengths: grade.strengths,
      gaps: grade.gaps,
      modelAnswer: grade.model_answer,
      rubric,
      eventId,
      masteryScore: score,
      masteryItemCount: itemCount,
    };
  });
}

export interface ScenarioAttemptSummary {
  id: string;
  promptId: string;
  overallScore: number;
  createdAt: Date;
  strengths: string[];
  gaps: string[];
}

export function listAttemptsForPrompt(
  promptId: string,
  db: Db = getAppDb(),
): ScenarioAttemptSummary[] {
  const rows = db
    .select()
    .from(schema.scenarioAttempts)
    .where(eq(schema.scenarioAttempts.promptId, promptId))
    .all();
  return rows
    .map((r) => {
      const fb = r.feedback as {
        strengths?: string[];
        gaps?: string[];
      };
      return {
        id: r.id,
        promptId: r.promptId,
        overallScore: r.overallScore,
        createdAt: r.createdAt,
        strengths: fb.strengths ?? [],
        gaps: fb.gaps ?? [],
      };
    })
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

export function getScenarioAttempt(
  attemptId: string,
  db: Db = getAppDb(),
): {
  id: string;
  promptId: string;
  answerText: string;
  overallScore: number;
  createdAt: Date;
  perCriterion: RecordGradeInput["per_criterion"];
  strengths: string[];
  gaps: string[];
  modelAnswer: string;
} | null {
  const row = db
    .select()
    .from(schema.scenarioAttempts)
    .where(eq(schema.scenarioAttempts.id, attemptId))
    .get();
  if (!row) return null;
  const fb = row.feedback as {
    perCriterion?: RecordGradeInput["per_criterion"];
    strengths?: string[];
    gaps?: string[];
    modelAnswer?: string;
  };
  return {
    id: row.id,
    promptId: row.promptId,
    answerText: row.answerText,
    overallScore: row.overallScore,
    createdAt: row.createdAt,
    perCriterion: fb.perCriterion ?? [],
    strengths: fb.strengths ?? [],
    gaps: fb.gaps ?? [],
    modelAnswer: fb.modelAnswer ?? "",
  };
}
