/**
 * SM-2 spaced repetition scheduler (SuperMemo-2, Woźniak 1990).
 *
 * Pure — no DB coupling. Given a card's prior `{easeFactor, intervalDays}` and
 * a grade, returns the next state and a `dueAt` timestamp.
 *
 * The four grade buttons map to SM-2's 0..5 quality scale:
 *   again → q=0  (failure — restart interval)
 *   hard  → q=3  (barely correct — ease factor drops)
 *   good  → q=4  (correct, no effort change)
 *   easy  → q=5  (perfect recall — ease factor rises, interval gets a bonus)
 *
 * Canonical SM-2 transitions (q ≥ 3):
 *   first review (intervalDays = 0)  → intervalDays = 1
 *   second review (intervalDays = 1) → intervalDays = 6
 *   subsequent                       → round(prev × EF)
 *
 * On failure (q < 3), the interval resets to 1 day (next review tomorrow)
 * and EF still receives its penalty. No "learn steps" sub-queue (that's
 * Anki-style, not SM-2). Consequence: a just-failed card shows up tomorrow,
 * not later in the same session — matches the documented algorithm per
 * DO-NOT #4 in spec.md (no hand-wavy SRS heuristics).
 *
 * EF update: EF' = EF + (0.1 - (5-q)(0.08 + (5-q)·0.02)), clamped at 1.3.
 *
 * References:
 *   https://super-memory.com/english/ol/sm2.htm (original algorithm spec)
 */

export type Grade = "again" | "hard" | "good" | "easy";

export const GRADE_QUALITY: Record<Grade, number> = {
  again: 0,
  hard: 3,
  good: 4,
  easy: 5,
};

export const MIN_EASE_FACTOR = 1.3;
export const DEFAULT_EASE_FACTOR = 2.5;
export const FAILURE_INTERVAL_DAYS = 1;
export const FIRST_GRADUATED_INTERVAL_DAYS = 1;
export const SECOND_GRADUATED_INTERVAL_DAYS = 6;
export const EASY_INTERVAL_BONUS = 1.3;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface Sm2State {
  /** Multiplier applied to interval on subsequent reviews. Starts at 2.5. */
  easeFactor: number;
  /** Days until the next review. 0 on a brand-new, never-graded card. */
  intervalDays: number;
}

export interface Sm2Outcome extends Sm2State {
  /** Milliseconds since epoch — when the card becomes due again */
  nextDueAt: number;
  /** The integer 0..5 quality score the grade maps to (for logging/telemetry) */
  quality: number;
}

/**
 * Apply a grade to a card's SM-2 state and return the next state + due date.
 * Pure — no side effects. `now` is the instant the grade was recorded; the
 * next due date is computed relative to it, not to the card's prior dueAt
 * (so late reviews don't compound).
 */
export function applyGrade(
  prev: Sm2State,
  grade: Grade,
  opts: { now: number },
): Sm2Outcome {
  const q = GRADE_QUALITY[grade];

  const efDelta = 0.1 - (5 - q) * (0.08 + (5 - q) * 0.02);
  const nextEase = Math.max(MIN_EASE_FACTOR, prev.easeFactor + efDelta);

  let nextInterval: number;
  if (q < 3) {
    nextInterval = FAILURE_INTERVAL_DAYS;
  } else if (prev.intervalDays <= 0) {
    nextInterval = FIRST_GRADUATED_INTERVAL_DAYS;
  } else if (prev.intervalDays < SECOND_GRADUATED_INTERVAL_DAYS) {
    // prior interval of 1 (or any fractional < 6) → second graduation step
    nextInterval = SECOND_GRADUATED_INTERVAL_DAYS;
  } else {
    nextInterval = Math.round(prev.intervalDays * nextEase);
  }

  // Easy bonus only applies once the card has graduated (prev > 1). Applying
  // it on brand-new cards would skip past the drilling window that SM-2 uses
  // to build memory traces.
  if (q === 5 && prev.intervalDays > 1) {
    nextInterval = Math.round(nextInterval * EASY_INTERVAL_BONUS);
  }

  return {
    easeFactor: nextEase,
    intervalDays: nextInterval,
    nextDueAt: opts.now + nextInterval * DAY_MS,
    quality: q,
  };
}

/**
 * Whether a grade counts as a successful review. Used to decide the `success`
 * flag on the progress event written alongside the SM-2 update.
 * q ≥ 3 → success; q < 3 (again) → failure.
 */
export function gradeIsSuccess(grade: Grade): boolean {
  return GRADE_QUALITY[grade] >= 3;
}
