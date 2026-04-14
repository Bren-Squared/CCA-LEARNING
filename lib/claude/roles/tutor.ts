import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../../db";
import { schema } from "../../db";
import { writeProgressEvent } from "../../progress/events";
import type { BloomLevel } from "../../progress/mastery";
import { toolError, type ToolDefinition } from "../tools";
import type { RoleDefinition } from "./types";

/**
 * Tutor tool set (FR2.5 / D1.1). Three narrow tools. They are the ONLY control
 * surface the tutor model has into application state — no natural-language
 * channels. The agentic loop in lib/tutor/loop.ts inspects `stop_reason` to
 * decide whether to keep looping or exit; it never parses assistant text to
 * infer intent.
 *
 * Handlers are DB-bound via `buildTutorToolSet(db)`. The exported zod schemas
 * and JSON Schemas are the source of truth for both the Claude API boundary
 * and the test fixtures (see D2.2 / AT19).
 */

// ---------------------------------------------------------------------------
// lookup_bullets
// ---------------------------------------------------------------------------

export const lookupBulletsInputSchema = z.object({
  task_statement_id: z.string().min(1),
});
export type LookupBulletsInput = z.infer<typeof lookupBulletsInputSchema>;

export interface LookupBulletsOutput {
  task_statement_id: string;
  title: string;
  knowledge_bullets: string[];
  skills_bullets: string[];
}

export function lookupBulletsTool(
  db: Db,
): ToolDefinition<LookupBulletsInput, LookupBulletsOutput> {
  return {
    name: "lookup_bullets",
    description:
      "Returns the verbatim Knowledge and Skills bullets for ONE task statement from the exam guide. Call this BEFORE quoting any exam-guide text so the quotation is exact (DO-NOT #6). The case-facts block already carries the current topic's bullets — only call this tool for a DIFFERENT task statement than the current one (e.g., when drawing a cross-domain connection). Do not use this tool to 'refresh' the current topic's bullets — they're always in the system prompt.",
    inputSchema: {
      type: "object",
      properties: {
        task_statement_id: {
          type: "string",
          description:
            "Dotted task statement id, e.g. 'D1.1' or 'D3.2'. Must exist in the curriculum.",
        },
      },
      required: ["task_statement_id"],
      additionalProperties: false,
    },
    validateInput: (raw) => {
      const parsed = lookupBulletsInputSchema.safeParse(raw);
      if (!parsed.success) {
        return toolError(
          "validation",
          `lookup_bullets input failed validation: ${parsed.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; ")}`,
          true,
        );
      }
      return { ok: true, value: parsed.data };
    },
    handler: (input) => {
      const row = db
        .select()
        .from(schema.taskStatements)
        .where(eq(schema.taskStatements.id, input.task_statement_id))
        .get();
      if (!row) {
        return toolError(
          "business",
          `task statement "${input.task_statement_id}" does not exist. Valid ids look like "D1.1", "D3.2". Do NOT retry with the same id.`,
          false,
        );
      }
      return {
        ok: true,
        data: {
          task_statement_id: row.id,
          title: row.title,
          knowledge_bullets: row.knowledgeBullets,
          skills_bullets: row.skillsBullets,
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// record_mastery
// ---------------------------------------------------------------------------

export const recordMasteryInputSchema = z.object({
  task_statement_id: z.string().min(1),
  bloom_level: z.number().int().min(1).max(6),
  outcome: z.enum(["success", "failure"]),
  note: z.string().max(400).optional(),
});
export type RecordMasteryInput = z.infer<typeof recordMasteryInputSchema>;

export interface RecordMasteryOutput {
  event_id: string;
  score: number;
  item_count: number;
  bloom_level: number;
  outcome: "success" | "failure";
}

export function recordMasteryTool(
  db: Db,
): ToolDefinition<RecordMasteryInput, RecordMasteryOutput> {
  return {
    name: "record_mastery",
    description:
      "Writes a Bloom-level mastery signal for the current tutoring topic to the progress log. Call EXACTLY when the user has demonstrated (success) or failed to demonstrate (failure) understanding at a specific Bloom level — not speculatively, not in advance. The event is immutable: callers must not 'correct' a previous call by recording the inverse. kind='tutor_signal' in the event log. The optional `note` (<= 400 chars) is a one-sentence rationale for later audit.",
    inputSchema: {
      type: "object",
      properties: {
        task_statement_id: {
          type: "string",
          description: "The task statement the signal applies to.",
        },
        bloom_level: {
          type: "integer",
          minimum: 1,
          maximum: 6,
          description:
            "Bloom level (1=Remember ... 6=Create). Use the level of the question the user just answered, not the level of the topic as a whole.",
        },
        outcome: {
          type: "string",
          enum: ["success", "failure"],
          description:
            "success = demonstrated understanding; failure = did not.",
        },
        note: {
          type: "string",
          maxLength: 400,
          description: "One-sentence rationale — what the user said/did.",
        },
      },
      required: ["task_statement_id", "bloom_level", "outcome"],
      additionalProperties: false,
    },
    validateInput: (raw) => {
      const parsed = recordMasteryInputSchema.safeParse(raw);
      if (!parsed.success) {
        return toolError(
          "validation",
          `record_mastery input failed validation: ${parsed.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; ")}`,
          true,
        );
      }
      return { ok: true, value: parsed.data };
    },
    handler: (input) => {
      const ts = db
        .select({ id: schema.taskStatements.id })
        .from(schema.taskStatements)
        .where(eq(schema.taskStatements.id, input.task_statement_id))
        .get();
      if (!ts) {
        return toolError(
          "business",
          `task statement "${input.task_statement_id}" does not exist.`,
          false,
        );
      }
      const res = writeProgressEvent(
        {
          kind: "tutor_signal",
          taskStatementId: input.task_statement_id,
          bloomLevel: input.bloom_level as BloomLevel,
          success: input.outcome === "success",
          payload: input.note ? { note: input.note } : {},
        },
        db,
      );
      return {
        ok: true,
        data: {
          event_id: res.eventId,
          score: res.score,
          item_count: res.itemCount,
          bloom_level: input.bloom_level,
          outcome: input.outcome,
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// spawn_practice_question
// ---------------------------------------------------------------------------

export const spawnPracticeQuestionInputSchema = z.object({
  task_statement_id: z.string().min(1),
  bloom_level: z.number().int().min(1).max(6),
});
export type SpawnPracticeQuestionInput = z.infer<
  typeof spawnPracticeQuestionInputSchema
>;

export interface SpawnPracticeQuestionOutput {
  question_id: string;
  stem: string;
  options: string[];
  correct_index: number;
  correct_explanation: string;
  bloom_level: number;
}

export function spawnPracticeQuestionTool(
  db: Db,
): ToolDefinition<SpawnPracticeQuestionInput, SpawnPracticeQuestionOutput> {
  return {
    name: "spawn_practice_question",
    description:
      "Draws ONE active MCQ from the question bank at the given (task_statement_id, bloom_level). Use this to probe the next Bloom level up when the user has demonstrated the current one. You receive the correct_index and its explanation — these are for YOUR reasoning only. Do NOT reveal correct_index to the user before they answer. Quote the stem and options verbatim in your next turn, then wait for their answer. Business error if no active questions exist at that cell.",
    inputSchema: {
      type: "object",
      properties: {
        task_statement_id: { type: "string" },
        bloom_level: { type: "integer", minimum: 1, maximum: 6 },
      },
      required: ["task_statement_id", "bloom_level"],
      additionalProperties: false,
    },
    validateInput: (raw) => {
      const parsed = spawnPracticeQuestionInputSchema.safeParse(raw);
      if (!parsed.success) {
        return toolError(
          "validation",
          `spawn_practice_question input failed validation: ${parsed.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; ")}`,
          true,
        );
      }
      return { ok: true, value: parsed.data };
    },
    handler: (input) => {
      const pool = db
        .select()
        .from(schema.questions)
        .where(
          and(
            eq(schema.questions.taskStatementId, input.task_statement_id),
            eq(schema.questions.bloomLevel, input.bloom_level),
            eq(schema.questions.status, "active"),
          ),
        )
        .all();
      if (pool.length === 0) {
        return toolError(
          "business",
          `no active questions at (${input.task_statement_id}, L${input.bloom_level}). Try a different Bloom level, or proceed with a free-form Socratic question.`,
          false,
        );
      }
      const pick = pool[Math.floor(Math.random() * pool.length)];
      const explanation =
        pick.explanations[pick.correctIndex] ?? pick.explanations[0] ?? "";
      return {
        ok: true,
        data: {
          question_id: pick.id,
          stem: pick.stem,
          options: pick.options,
          correct_index: pick.correctIndex,
          correct_explanation: explanation,
          bloom_level: pick.bloomLevel,
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// reveal_answer (D5.2 — escalation)
// ---------------------------------------------------------------------------

export const REVEAL_REASONS = [
  "explicit_ask",
  "three_failed_hints",
  "policy_gap",
] as const;

export const revealAnswerInputSchema = z.object({
  task_statement_id: z.string().min(1),
  bloom_level: z.number().int().min(1).max(6),
  reason: z.enum(REVEAL_REASONS),
  note: z.string().max(400).optional(),
});
export type RevealAnswerInput = z.infer<typeof revealAnswerInputSchema>;

export interface RevealAnswerOutput {
  event_id: string;
  reason: (typeof REVEAL_REASONS)[number];
  bloom_level: number;
}

export function revealAnswerTool(
  db: Db,
): ToolDefinition<RevealAnswerInput, RevealAnswerOutput> {
  return {
    name: "reveal_answer",
    description:
      "Marks the current Socratic thread as 'hand-off' — the user has explicitly asked for the answer, or has failed three consecutive hints at this Bloom level, or the exam-guide bullets don't cover the concept (policy gap). CALL THIS BEFORE writing the explanation to the user so the event log records that the outcome was reveal-driven (success=false). Do NOT call this tool pre-emptively or to short-circuit Socratic questioning; reserve it for the three D5.2 triggers. Writes a tutor_signal event with payload.escalation = reason.",
    inputSchema: {
      type: "object",
      properties: {
        task_statement_id: { type: "string" },
        bloom_level: { type: "integer", minimum: 1, maximum: 6 },
        reason: {
          type: "string",
          enum: [...REVEAL_REASONS],
          description:
            "Which D5.2 trigger fired: explicit_ask | three_failed_hints | policy_gap.",
        },
        note: {
          type: "string",
          maxLength: 400,
          description: "One-sentence context — e.g. 'user asked: just tell me'.",
        },
      },
      required: ["task_statement_id", "bloom_level", "reason"],
      additionalProperties: false,
    },
    validateInput: (raw) => {
      const parsed = revealAnswerInputSchema.safeParse(raw);
      if (!parsed.success) {
        return toolError(
          "validation",
          `reveal_answer input failed validation: ${parsed.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; ")}`,
          true,
        );
      }
      return { ok: true, value: parsed.data };
    },
    handler: (input) => {
      const ts = db
        .select({ id: schema.taskStatements.id })
        .from(schema.taskStatements)
        .where(eq(schema.taskStatements.id, input.task_statement_id))
        .get();
      if (!ts) {
        return toolError(
          "business",
          `task statement "${input.task_statement_id}" does not exist.`,
          false,
        );
      }
      const res = writeProgressEvent(
        {
          kind: "tutor_signal",
          taskStatementId: input.task_statement_id,
          bloomLevel: input.bloom_level as BloomLevel,
          success: false,
          payload: {
            escalation: input.reason,
            ...(input.note ? { note: input.note } : {}),
          },
        },
        db,
      );
      return {
        ok: true,
        data: {
          event_id: res.eventId,
          reason: input.reason,
          bloom_level: input.bloom_level,
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Tool set factory — binds db to all four handlers for one request.
// ---------------------------------------------------------------------------

// Heterogenous tool shapes at the role surface — same pattern as RoleDefinition.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTutorTool = ToolDefinition<any, any>;

export interface TutorToolSet {
  tools: AnyTutorTool[];
  byName: Map<string, AnyTutorTool>;
}

export function buildTutorToolSet(db: Db): TutorToolSet {
  const tools: AnyTutorTool[] = [
    lookupBulletsTool(db),
    recordMasteryTool(db),
    spawnPracticeQuestionTool(db),
    revealAnswerTool(db),
  ];
  const byName = new Map<string, AnyTutorTool>();
  for (const t of tools) byName.set(t.name, t);
  return { tools, byName };
}

// ---------------------------------------------------------------------------
// Role
// ---------------------------------------------------------------------------

/**
 * Socratic tutor role. The agentic loop in lib/tutor/loop.ts binds the tool
 * handlers per-request (they need a DB handle), so `tools: []` here is
 * intentional — the role is a descriptor, not a runtime registry.
 */
export const tutorRole: RoleDefinition = {
  name: "tutor",
  description:
    "Asks Socratic questions grounded in a single task statement's Knowledge/Skills bullets. Uses lookup_bullets to cite cross-domain exam-guide text verbatim; calls record_mastery when the user succeeds or fails at a specific Bloom level; calls spawn_practice_question to probe the next level. No text-content heuristics — the agentic loop is driven by stop_reason only (D1.1).",
  systemPromptId: "tutor.socratic",
  cacheSystem: true,
  modelTier: "default",
  tools: [],
};
