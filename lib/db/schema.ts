import { sql } from "drizzle-orm";
import {
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

// ---------------------------------------------------------------------------
// Curriculum (ingested from the exam guide; idempotent re-ingest per FR1.3)
// ---------------------------------------------------------------------------

export const domains = sqliteTable("domains", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  weightBps: integer("weight_bps").notNull(),
  orderIndex: integer("order_index").notNull(),
});

export const taskStatements = sqliteTable("task_statements", {
  id: text("id").primaryKey(),
  domainId: text("domain_id")
    .notNull()
    .references(() => domains.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  knowledgeBullets: text("knowledge_bullets", { mode: "json" })
    .$type<string[]>()
    .notNull(),
  skillsBullets: text("skills_bullets", { mode: "json" })
    .$type<string[]>()
    .notNull(),
  orderIndex: integer("order_index").notNull(),
});

export const scenarios = sqliteTable("scenarios", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  orderIndex: integer("order_index").notNull(),
});

export const scenarioDomainMap = sqliteTable(
  "scenario_domain_map",
  {
    scenarioId: text("scenario_id")
      .notNull()
      .references(() => scenarios.id, { onDelete: "cascade" }),
    domainId: text("domain_id")
      .notNull()
      .references(() => domains.id, { onDelete: "cascade" }),
    isPrimary: integer("is_primary", { mode: "boolean" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.scenarioId, t.domainId] })],
);

export const questions = sqliteTable("questions", {
  id: text("id").primaryKey(),
  stem: text("stem").notNull(),
  options: text("options", { mode: "json" }).$type<string[]>().notNull(),
  correctIndex: integer("correct_index").notNull(),
  explanations: text("explanations", { mode: "json" })
    .$type<string[]>()
    .notNull(),
  taskStatementId: text("task_statement_id")
    .notNull()
    .references(() => taskStatements.id, { onDelete: "cascade" }),
  scenarioId: text("scenario_id").references(() => scenarios.id, {
    onDelete: "set null",
  }),
  difficulty: integer("difficulty").notNull(),
  bloomLevel: integer("bloom_level").notNull(),
  bloomJustification: text("bloom_justification").notNull(),
  source: text("source", { enum: ["seed", "generated"] }).notNull(),
  status: text("status", { enum: ["active", "flagged", "retired"] })
    .notNull()
    .default("active"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch('subsec') * 1000)`),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch('subsec') * 1000)`),
});

export const flashcards = sqliteTable("flashcards", {
  id: text("id").primaryKey(),
  taskStatementId: text("task_statement_id")
    .notNull()
    .references(() => taskStatements.id, { onDelete: "cascade" }),
  front: text("front").notNull(),
  back: text("back").notNull(),
  bloomLevel: integer("bloom_level").notNull(),
  easeFactor: real("ease_factor").notNull().default(2.5),
  intervalDays: real("interval_days").notNull().default(0),
  dueAt: integer("due_at", { mode: "timestamp_ms" }).notNull(),
  reviewsCount: integer("reviews_count").notNull().default(0),
  lastReviewedAt: integer("last_reviewed_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch('subsec') * 1000)`),
});

export const preparationExercises = sqliteTable("preparation_exercises", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  domainsReinforced: text("domains_reinforced", { mode: "json" })
    .$type<string[]>()
    .notNull(),
  orderIndex: integer("order_index").notNull(),
});

export const preparationSteps = sqliteTable(
  "preparation_steps",
  {
    id: text("id").primaryKey(),
    exerciseId: text("exercise_id")
      .notNull()
      .references(() => preparationExercises.id, { onDelete: "cascade" }),
    stepIdx: integer("step_idx").notNull(),
    prompt: text("prompt").notNull(),
    rubric: text("rubric", { mode: "json" }).$type<
      Record<string, unknown>
    >(),
  },
);

// ---------------------------------------------------------------------------
// Progress (append-only events + derived snapshots; FR4)
// ---------------------------------------------------------------------------

export const progressEvents = sqliteTable("progress_events", {
  id: text("id").primaryKey(),
  ts: integer("ts", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch('subsec') * 1000)`),
  kind: text("kind", {
    enum: [
      "mcq_answer",
      "flashcard_grade",
      "scenario_grade",
      "tutor_signal",
      "exercise_step_grade",
      "explainer_check",
    ],
  }).notNull(),
  taskStatementId: text("task_statement_id")
    .notNull()
    .references(() => taskStatements.id, { onDelete: "cascade" }),
  bloomLevel: integer("bloom_level").notNull(),
  success: integer("success", { mode: "boolean" }).notNull(),
  payload: text("payload", { mode: "json" })
    .$type<Record<string, unknown>>()
    .notNull(),
});

export const masterySnapshots = sqliteTable(
  "mastery_snapshots",
  {
    taskStatementId: text("task_statement_id")
      .notNull()
      .references(() => taskStatements.id, { onDelete: "cascade" }),
    bloomLevel: integer("bloom_level").notNull(),
    score: real("score").notNull().default(0),
    itemCount: integer("item_count").notNull().default(0),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch('subsec') * 1000)`),
  },
  (t) => [primaryKey({ columns: [t.taskStatementId, t.bloomLevel] })],
);

export const mockAttempts = sqliteTable("mock_attempts", {
  id: text("id").primaryKey(),
  startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
  finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  status: text("status", {
    enum: ["in_progress", "submitted", "timeout", "reviewed"],
  })
    .notNull()
    .default("in_progress"),
  questionIds: text("question_ids", { mode: "json" })
    .$type<string[]>()
    .notNull(),
  answers: text("answers", { mode: "json" })
    .$type<Array<number | null>>()
    .notNull(),
  scenarioIds: text("scenario_ids", { mode: "json" })
    .$type<string[]>()
    .notNull(),
  rawScore: integer("raw_score"),
  scaledScore: integer("scaled_score"),
  passed: integer("passed", { mode: "boolean" }),
});

export const preparationAttempts = sqliteTable("preparation_attempts", {
  id: text("id").primaryKey(),
  stepId: text("step_id")
    .notNull()
    .references(() => preparationSteps.id, { onDelete: "cascade" }),
  artifactText: text("artifact_text").notNull(),
  grade: real("grade"),
  feedback: text("feedback", { mode: "json" }).$type<
    Record<string, unknown>
  >(),
  ts: integer("ts", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch('subsec') * 1000)`),
});

export const tutorSessions = sqliteTable("tutor_sessions", {
  id: text("id").primaryKey(),
  topicId: text("topic_id").notNull(),
  messages: text("messages", { mode: "json" })
    .$type<Array<{ role: string; content: unknown }>>()
    .notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch('subsec') * 1000)`),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch('subsec') * 1000)`),
});

// ---------------------------------------------------------------------------
// Claude API call log (token usage + cost; feeds the Phase 13 spend page)
// ---------------------------------------------------------------------------

export const claudeCallLog = sqliteTable("claude_call_log", {
  id: text("id").primaryKey(),
  ts: integer("ts", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch('subsec') * 1000)`),
  role: text("role").notNull(),
  model: text("model").notNull(),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  cacheCreationInputTokens: integer("cache_creation_input_tokens")
    .notNull()
    .default(0),
  cacheReadInputTokens: integer("cache_read_input_tokens").notNull().default(0),
  estimatedCostUsd: real("estimated_cost_usd").notNull().default(0),
  stopReason: text("stop_reason"),
  durationMs: integer("duration_ms").notNull().default(0),
});

// ---------------------------------------------------------------------------
// Settings (single-row singleton; FR5)
// ---------------------------------------------------------------------------

export const settings = sqliteTable("settings", {
  id: integer("id").primaryKey().default(1),
  apiKeyEncrypted: text("api_key_encrypted"),
  defaultModel: text("default_model")
    .notNull()
    .default("claude-sonnet-4-6"),
  cheapModel: text("cheap_model")
    .notNull()
    .default("claude-haiku-4-5-20251001"),
  tokenBudgetMonthUsd: real("token_budget_month_usd").notNull().default(50),
  bulkCostCeilingUsd: real("bulk_cost_ceiling_usd").notNull().default(1.0),
  reviewHalfLifeDays: real("review_half_life_days").notNull().default(14),
  darkMode: integer("dark_mode", { mode: "boolean" }).notNull().default(false),
  ingestPdfHash: text("ingest_pdf_hash"),
  ingestedAt: integer("ingested_at", { mode: "timestamp_ms" }),
});

// ---------------------------------------------------------------------------
// Inferred types (NFR6.1: adding a column flows to callers automatically)
// ---------------------------------------------------------------------------

export type Domain = typeof domains.$inferSelect;
export type NewDomain = typeof domains.$inferInsert;
export type TaskStatement = typeof taskStatements.$inferSelect;
export type NewTaskStatement = typeof taskStatements.$inferInsert;
export type Scenario = typeof scenarios.$inferSelect;
export type NewScenario = typeof scenarios.$inferInsert;
export type Question = typeof questions.$inferSelect;
export type NewQuestion = typeof questions.$inferInsert;
export type Flashcard = typeof flashcards.$inferSelect;
export type NewFlashcard = typeof flashcards.$inferInsert;
export type PreparationExercise = typeof preparationExercises.$inferSelect;
export type NewPreparationExercise = typeof preparationExercises.$inferInsert;
export type PreparationStep = typeof preparationSteps.$inferSelect;
export type NewPreparationStep = typeof preparationSteps.$inferInsert;
export type PreparationAttempt = typeof preparationAttempts.$inferSelect;
export type NewPreparationAttempt = typeof preparationAttempts.$inferInsert;
export type ProgressEvent = typeof progressEvents.$inferSelect;
export type NewProgressEvent = typeof progressEvents.$inferInsert;
export type MasterySnapshot = typeof masterySnapshots.$inferSelect;
export type NewMasterySnapshot = typeof masterySnapshots.$inferInsert;
export type MockAttempt = typeof mockAttempts.$inferSelect;
export type NewMockAttempt = typeof mockAttempts.$inferInsert;
export type TutorSession = typeof tutorSessions.$inferSelect;
export type NewTutorSession = typeof tutorSessions.$inferInsert;
export type Settings = typeof settings.$inferSelect;
export type NewSettings = typeof settings.$inferInsert;
export type ClaudeCallLog = typeof claudeCallLog.$inferSelect;
export type NewClaudeCallLog = typeof claudeCallLog.$inferInsert;
