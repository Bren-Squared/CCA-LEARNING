import { eq } from "drizzle-orm";
import { type Db, getAppDb, schema } from "../db";
import { readSettings } from "../settings";
import { type BloomLevel } from "../progress/mastery";
import { refreshSnapshot } from "../progress/events";
import { applyGrade, type Grade, gradeIsSuccess } from "../progress/sm2";
import { randomUUID } from "node:crypto";

/**
 * Apply a flashcard grade: updates SM-2 state on the card, appends a
 * `flashcard_grade` progress event at the card's Bloom level, and refreshes
 * the (taskStatement, bloomLevel) mastery snapshot — all in one transaction.
 *
 * This mirrors `writeProgressEvent` (lib/progress/events.ts) but with the
 * flashcard state update baked in. Keeping it together means a grade is
 * either fully applied or not applied — no half-written state if the
 * snapshot refresh fails mid-way.
 */

export class FlashcardGradeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "FlashcardGradeError";
  }
}

export interface FlashcardGradeResult {
  cardId: string;
  grade: Grade;
  quality: number;
  success: boolean;
  easeFactor: number;
  intervalDays: number;
  dueAt: Date;
  reviewsCount: number;
  eventId: string;
  score: number;
  itemCount: number;
}

export function applyFlashcardGrade(
  cardId: string,
  grade: Grade,
  opts: { db?: Db; now?: Date } = {},
): FlashcardGradeResult {
  const db = opts.db ?? getAppDb();
  const now = opts.now ?? new Date();
  const nowMs = now.getTime();
  const halfLifeDays = readSettings(db).reviewHalfLifeDays;

  return db.transaction((tx) => {
    const card = tx
      .select()
      .from(schema.flashcards)
      .where(eq(schema.flashcards.id, cardId))
      .get();
    if (!card) {
      throw new FlashcardGradeError(
        "not_found",
        `flashcard "${cardId}" not found`,
      );
    }

    const outcome = applyGrade(
      { easeFactor: card.easeFactor, intervalDays: card.intervalDays },
      grade,
      { now: nowMs },
    );
    const success = gradeIsSuccess(grade);
    const nextDueAt = new Date(outcome.nextDueAt);
    const nextReviewsCount = card.reviewsCount + 1;

    tx.update(schema.flashcards)
      .set({
        easeFactor: outcome.easeFactor,
        intervalDays: outcome.intervalDays,
        dueAt: nextDueAt,
        reviewsCount: nextReviewsCount,
        lastReviewedAt: now,
      })
      .where(eq(schema.flashcards.id, cardId))
      .run();

    const eventId = randomUUID();
    tx.insert(schema.progressEvents)
      .values({
        id: eventId,
        ts: now,
        kind: "flashcard_grade",
        taskStatementId: card.taskStatementId,
        bloomLevel: card.bloomLevel,
        success,
        payload: {
          cardId,
          grade,
          quality: outcome.quality,
          easeFactor: outcome.easeFactor,
          intervalDays: outcome.intervalDays,
        },
      })
      .run();

    const { score, itemCount } = refreshSnapshot(
      card.taskStatementId,
      card.bloomLevel as BloomLevel,
      { now: nowMs, halfLifeDays },
      tx,
    );

    return {
      cardId,
      grade,
      quality: outcome.quality,
      success,
      easeFactor: outcome.easeFactor,
      intervalDays: outcome.intervalDays,
      dueAt: nextDueAt,
      reviewsCount: nextReviewsCount,
      eventId,
      score,
      itemCount,
    };
  });
}
