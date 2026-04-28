import { and, asc, eq, lte } from "drizzle-orm";
import type { Db, DbClient } from "../db";
import { getAppDb, schema } from "../db";
import { applyGrade, type Grade } from "../progress/sm2";

/**
 * SRS scheduler for missed MCQs (E2 / AT21).
 *
 * Treats every MCQ answer as input to the SM-2 scheduler that already drives
 * flashcards (`lib/progress/sm2.ts`). The mapping is intentionally conservative:
 *
 *   correct → quality=4 ("good"), advances the interval per SM-2
 *   wrong   → quality=1 ("again"), resets interval to 1 day with EF penalty
 *
 * Why "good" and not "easy" on success: an MCQ correct demonstrates *recognition*
 * under a four-option prompt, not unaided recall. SM-2's "easy" bonus was tuned
 * for free-recall flashcards. Holding success at "good" keeps the interval
 * curve realistic for exam prep — the user re-encounters the same question
 * at a sane cadence rather than getting blasted past it.
 *
 * Why we use SM-2's `applyGrade` directly rather than re-implementing: the
 * algorithm is already documented, tested, and the only SRS scheduler in the
 * project (DO-NOT #4: no hand-wavy heuristics).
 */

export const SUCCESS_GRADE: Grade = "good";
export const FAILURE_GRADE: Grade = "again";

/**
 * Apply an MCQ answer outcome to the question's SRS state. Idempotent on a
 * given (questionId, ts) pair — re-running with the same `now` produces the
 * same row contents (last write wins for late-arriving duplicates, but the
 * `progress_events` log preserves the full history).
 *
 * Caller passes a `DbClient` (raw Db OR a transaction handle) so this can run
 * inside the existing `writeProgressEvent` transaction without nesting.
 */
export function applyMcqAttempt(
  questionId: string,
  success: boolean,
  opts: { now: number },
  db: DbClient,
): {
  dueAt: number;
  intervalDays: number;
  easeFactor: number;
  quality: number;
  applied: boolean;
} {
  // Defensive: if the question id doesn't exist in the bank, the FK on
  // mcq_review_state would reject the insert and break the surrounding
  // progress-event transaction. Real drill writes always carry a valid id;
  // seed/test/synthetic writers may not. Skip silently when the parent row
  // is missing rather than failing the whole event-log append.
  const exists = db
    .select({ id: schema.questions.id })
    .from(schema.questions)
    .where(eq(schema.questions.id, questionId))
    .get();
  if (!exists) {
    return {
      dueAt: opts.now,
      intervalDays: 0,
      easeFactor: 2.5,
      quality: success ? 4 : 0,
      applied: false,
    };
  }

  const prior = db
    .select()
    .from(schema.mcqReviewState)
    .where(eq(schema.mcqReviewState.questionId, questionId))
    .get();

  const grade = success ? SUCCESS_GRADE : FAILURE_GRADE;
  const outcome = applyGrade(
    {
      easeFactor: prior?.easeFactor ?? 2.5,
      intervalDays: prior?.intervalDays ?? 0,
    },
    grade,
    { now: opts.now },
  );

  const reviewsCount = (prior?.reviewsCount ?? 0) + 1;
  const dueAtDate = new Date(outcome.nextDueAt);
  const reviewedAt = new Date(opts.now);

  db.insert(schema.mcqReviewState)
    .values({
      questionId,
      easeFactor: outcome.easeFactor,
      intervalDays: outcome.intervalDays,
      dueAt: dueAtDate,
      lastGrade: outcome.quality,
      reviewsCount,
      lastReviewedAt: reviewedAt,
    })
    .onConflictDoUpdate({
      target: schema.mcqReviewState.questionId,
      set: {
        easeFactor: outcome.easeFactor,
        intervalDays: outcome.intervalDays,
        dueAt: dueAtDate,
        lastGrade: outcome.quality,
        reviewsCount,
        lastReviewedAt: reviewedAt,
      },
    })
    .run();

  return {
    dueAt: outcome.nextDueAt,
    intervalDays: outcome.intervalDays,
    easeFactor: outcome.easeFactor,
    quality: outcome.quality,
    applied: true,
  };
}

export interface DueMcqRow {
  questionId: string;
  dueAt: number;
  intervalDays: number;
  easeFactor: number;
  reviewsCount: number;
}

/**
 * List question IDs whose `due_at` is at or before `now`, ordered most-overdue
 * first. Joined to `questions.status='active'` so retired/flagged items drop
 * out of the queue automatically.
 */
export function listDueMcqs(
  opts: { now?: number; limit?: number; db?: Db } = {},
): DueMcqRow[] {
  const db = opts.db ?? getAppDb();
  const nowMs = opts.now ?? Date.now();
  const nowDate = new Date(nowMs);
  const limit = opts.limit ?? 50;

  const rows = db
    .select({
      questionId: schema.mcqReviewState.questionId,
      dueAt: schema.mcqReviewState.dueAt,
      intervalDays: schema.mcqReviewState.intervalDays,
      easeFactor: schema.mcqReviewState.easeFactor,
      reviewsCount: schema.mcqReviewState.reviewsCount,
      status: schema.questions.status,
    })
    .from(schema.mcqReviewState)
    .innerJoin(
      schema.questions,
      eq(schema.questions.id, schema.mcqReviewState.questionId),
    )
    .where(
      and(
        lte(schema.mcqReviewState.dueAt, nowDate),
        eq(schema.questions.status, "active"),
      ),
    )
    .orderBy(asc(schema.mcqReviewState.dueAt))
    .limit(limit)
    .all();

  return rows.map((r) => ({
    questionId: r.questionId,
    dueAt: r.dueAt.getTime(),
    intervalDays: r.intervalDays,
    easeFactor: r.easeFactor,
    reviewsCount: r.reviewsCount,
  }));
}

export function countDueMcqs(
  opts: { now?: number; db?: Db } = {},
): number {
  const db = opts.db ?? getAppDb();
  const nowDate = new Date(opts.now ?? Date.now());
  const rows = db
    .select({ id: schema.mcqReviewState.questionId })
    .from(schema.mcqReviewState)
    .innerJoin(
      schema.questions,
      eq(schema.questions.id, schema.mcqReviewState.questionId),
    )
    .where(
      and(
        lte(schema.mcqReviewState.dueAt, nowDate),
        eq(schema.questions.status, "active"),
      ),
    )
    .all();
  return rows.length;
}
