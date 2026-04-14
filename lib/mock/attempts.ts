import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import type { Db } from "../db";
import { getAppDb, schema } from "../db";
import { writeProgressEvent } from "../progress/events";
import type { BloomLevel } from "../progress/mastery";
import {
  MOCK_DURATION_MS,
  MOCK_TOTAL_QUESTIONS,
  buildMockAllocation,
} from "./allocate";

/**
 * Mock-exam state machine (FR2.6).
 *
 * Lifecycle: `in_progress` → (`submitted` | `timeout`) after finish is
 * called or the deadline passes. No reopening. Autosave happens after
 * every `submitAnswer` so NFR2.2 (survive page refresh / backend restart)
 * is satisfied by the persistence layer alone — the UI doesn't have to do
 * anything clever.
 *
 * Scaled scoring (RD2) uses a piecewise-linear mapping anchored at the
 * pass line: raw 0 → scaled 100, raw 0.72 → scaled 720, raw 1.0 → scaled
 * 1000. The two slopes differ (below / above pass) which keeps the pass
 * threshold exact at the documented 720 mark.
 */

export const MOCK_PASS_SCALED = 720;
export const MOCK_PASS_RAW_RATIO = 0.72;
export const MOCK_SCALED_MIN = 100;
export const MOCK_SCALED_MAX = 1000;

export class MockAttemptError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "MockAttemptError";
  }
}

export interface MockAttemptRecord {
  id: string;
  startedAt: number;
  finishedAt: number | null;
  durationMs: number;
  status: "in_progress" | "submitted" | "timeout" | "reviewed";
  questionIds: string[];
  answers: Array<number | null>;
  scenarioIds: string[];
  rawScore: number | null;
  scaledScore: number | null;
  passed: boolean | null;
  /** Server-computed view: positive while in progress, 0 past deadline. */
  remainingMs: number;
  /** Server-computed view: true when in_progress and past deadline. */
  isExpired: boolean;
}

function toRecord(
  row: typeof schema.mockAttempts.$inferSelect,
  now: number,
): MockAttemptRecord {
  const startedAtMs = row.startedAt.getTime();
  const deadline = startedAtMs + row.durationMs;
  const active = row.status === "in_progress";
  const remainingMs = active ? Math.max(0, deadline - now) : 0;
  const isExpired = active && now >= deadline;
  return {
    id: row.id,
    startedAt: startedAtMs,
    finishedAt: row.finishedAt ? row.finishedAt.getTime() : null,
    durationMs: row.durationMs,
    status: row.status,
    questionIds: row.questionIds,
    answers: row.answers,
    scenarioIds: row.scenarioIds,
    rawScore: row.rawScore,
    scaledScore: row.scaledScore,
    passed: row.passed,
    remainingMs,
    isExpired,
  };
}

/**
 * Piecewise-linear raw (0..1) → scaled (100..1000) mapping. 72% raw is
 * pinned to 720 scaled so the pass line in the UI matches the actual
 * boundary.  Rounds to the nearest integer.
 */
export function rawToScaled(rawRatio: number): number {
  const r = Math.max(0, Math.min(1, rawRatio));
  const scaled =
    r <= MOCK_PASS_RAW_RATIO
      ? MOCK_SCALED_MIN +
        (r / MOCK_PASS_RAW_RATIO) * (MOCK_PASS_SCALED - MOCK_SCALED_MIN)
      : MOCK_PASS_SCALED +
        ((r - MOCK_PASS_RAW_RATIO) / (1 - MOCK_PASS_RAW_RATIO)) *
          (MOCK_SCALED_MAX - MOCK_PASS_SCALED);
  return Math.round(scaled);
}

export interface StartMockOpts {
  db?: Db;
  seed?: number;
  durationMs?: number;
  now?: Date;
}

/**
 * Start a new mock attempt. Allocates 60 exam-band questions across 4 random
 * scenarios, persists the attempt row with empty answers, and returns the
 * fully-populated record. Throws `MockAllocationError` (with codes
 * `insufficient_questions` / `insufficient_scenarios`) if the bank or
 * scenario set is under-filled.
 */
export function startMockAttempt(opts: StartMockOpts = {}): MockAttemptRecord {
  const db = opts.db ?? getAppDb();
  const now = opts.now ?? new Date();
  const alloc = buildMockAllocation({ db, seed: opts.seed });
  const id = randomUUID();
  const durationMs = opts.durationMs ?? MOCK_DURATION_MS;
  db.insert(schema.mockAttempts)
    .values({
      id,
      startedAt: now,
      durationMs,
      status: "in_progress",
      questionIds: alloc.questionIds,
      answers: new Array<number | null>(alloc.questionIds.length).fill(null),
      scenarioIds: alloc.scenarioIds,
    })
    .run();
  return getMockAttempt(id, { db, now });
}

export interface GetMockOpts {
  db?: Db;
  now?: Date;
}

export function getMockAttempt(
  id: string,
  opts: GetMockOpts = {},
): MockAttemptRecord {
  const db = opts.db ?? getAppDb();
  const now = (opts.now ?? new Date()).getTime();
  const row = db
    .select()
    .from(schema.mockAttempts)
    .where(eq(schema.mockAttempts.id, id))
    .get();
  if (!row) {
    throw new MockAttemptError("not_found", `mock attempt ${id} not found`);
  }
  return toRecord(row, now);
}

export interface ListMockOpts {
  db?: Db;
  limit?: number;
}

export function listMockAttempts(opts: ListMockOpts = {}): MockAttemptRecord[] {
  const db = opts.db ?? getAppDb();
  const limit = opts.limit ?? 50;
  const now = Date.now();
  const rows = db
    .select()
    .from(schema.mockAttempts)
    .limit(limit)
    .all();
  return rows
    .map((r) => toRecord(r, now))
    .sort((a, b) => b.startedAt - a.startedAt);
}

export interface SubmitAnswerOpts {
  db?: Db;
  now?: Date;
}

/**
 * Record the user's answer for question index `qIdx`. Short-circuits to
 * `finishMockAttempt` when the deadline has already passed (status becomes
 * `timeout`, not `submitted`). Allowed to overwrite a prior answer on the
 * same index — the user is free to change their mind during the exam.
 */
export function submitAnswer(
  attemptId: string,
  qIdx: number,
  optionIdx: number | null,
  opts: SubmitAnswerOpts = {},
): MockAttemptRecord {
  const db = opts.db ?? getAppDb();
  const now = opts.now ?? new Date();
  const record = getMockAttempt(attemptId, { db, now });
  if (record.status !== "in_progress") {
    throw new MockAttemptError(
      "not_in_progress",
      `cannot submit an answer to a ${record.status} attempt`,
    );
  }
  if (record.isExpired) {
    return finishMockAttempt(attemptId, { db, now, reason: "timeout" });
  }
  if (qIdx < 0 || qIdx >= record.questionIds.length) {
    throw new MockAttemptError(
      "bad_question_index",
      `question index ${qIdx} out of range [0, ${record.questionIds.length})`,
    );
  }
  if (optionIdx !== null && (optionIdx < 0 || optionIdx > 3)) {
    throw new MockAttemptError(
      "bad_option_index",
      `option index ${optionIdx} must be 0-3 or null`,
    );
  }
  const nextAnswers = record.answers.slice();
  nextAnswers[qIdx] = optionIdx;
  db.update(schema.mockAttempts)
    .set({ answers: nextAnswers })
    .where(eq(schema.mockAttempts.id, attemptId))
    .run();
  return getMockAttempt(attemptId, { db, now });
}

export interface FinishMockOpts {
  db?: Db;
  now?: Date;
  /** Which terminal status to record. `timeout` is chosen automatically on deadline. */
  reason?: "submitted" | "timeout";
}

interface QuestionGradeData {
  id: string;
  correctIndex: number;
  taskStatementId: string;
  bloomLevel: number;
}

/**
 * Finalize an attempt. Computes raw score = (# correct) / 60, maps to
 * scaled score via `rawToScaled`, writes one `mcq_answer` progress event
 * per question (unanswered = success:false at the question's Bloom level),
 * and refreshes the mastery snapshots for every affected (TS, level) cell.
 *
 * Idempotent: calling finish on a terminal attempt returns it unchanged.
 */
export function finishMockAttempt(
  attemptId: string,
  opts: FinishMockOpts = {},
): MockAttemptRecord {
  const db = opts.db ?? getAppDb();
  const now = opts.now ?? new Date();
  const record = getMockAttempt(attemptId, { db, now });
  if (record.status !== "in_progress") return record;

  const reason =
    opts.reason ?? (record.isExpired ? "timeout" : "submitted");

  const qs = db
    .select({
      id: schema.questions.id,
      correctIndex: schema.questions.correctIndex,
      taskStatementId: schema.questions.taskStatementId,
      bloomLevel: schema.questions.bloomLevel,
    })
    .from(schema.questions)
    .where(inArray(schema.questions.id, record.questionIds))
    .all() as QuestionGradeData[];

  const byId = new Map(qs.map((q) => [q.id, q]));

  let correctCount = 0;
  for (let i = 0; i < record.questionIds.length; i++) {
    const qid = record.questionIds[i];
    const grading = byId.get(qid);
    if (!grading) continue;
    const answer = record.answers[i];
    const success = answer !== null && answer === grading.correctIndex;
    if (success) correctCount += 1;
    writeProgressEvent(
      {
        kind: "mcq_answer",
        taskStatementId: grading.taskStatementId,
        bloomLevel: grading.bloomLevel as BloomLevel,
        success,
        payload: {
          source: "mock_exam",
          attemptId,
          questionId: qid,
          questionIndex: i,
          selectedIndex: answer,
          correctIndex: grading.correctIndex,
          reason,
        },
      },
      db,
    );
  }

  const rawRatio = correctCount / MOCK_TOTAL_QUESTIONS;
  const scaledScore = rawToScaled(rawRatio);
  const passed = scaledScore >= MOCK_PASS_SCALED;

  db.update(schema.mockAttempts)
    .set({
      status: reason,
      finishedAt: now,
      rawScore: correctCount,
      scaledScore,
      passed,
    })
    .where(eq(schema.mockAttempts.id, attemptId))
    .run();

  return getMockAttempt(attemptId, { db, now });
}

export { MOCK_DURATION_MS, MOCK_TOTAL_QUESTIONS, MockAllocationError } from "./allocate";
