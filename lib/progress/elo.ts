/**
 * Glicko-1 rating system (Glickman 1995). Single round, single opponent —
 * suitable for the per-MCQ-attempt update we want.
 *
 * Pure functions, no DB coupling. Inputs are `{rating, rd}` (rating + rating
 * deviation) on both sides; output is the updated `{rating, rd}` for the
 * subject of the call. Symmetric pairs are computed by calling once for each
 * side: `updateGlicko(user, question, score)` updates the user;
 * `updateGlicko(question, user, 1-score)` updates the question.
 *
 * Why Glicko-1 over Glicko-2: Glicko-1 has only two state variables and one
 * tunable (rating volatility decay handled outside the rating update) — easier
 * to reason about than Glicko-2's volatility-of-volatility loop, and the gain
 * matters less at single-user scale where the rating moves slowly anyway.
 *
 * Mathematical reference:
 *   g(RD) = 1 / sqrt(1 + (3 q² RD²) / π²)
 *   E(s | r, r_j, RD_j) = 1 / (1 + 10^(-g(RD_j)(r - r_j)/400))
 *   d² = 1 / (q² g(RD_j)² E(1-E))
 *   r' = r + (q / (1/RD² + 1/d²)) g(RD_j) (s - E)
 *   RD'² = (1/RD² + 1/d²)^(-1)
 *   q = ln(10) / 400
 */

export const Q = Math.log(10) / 400;
export const DEFAULT_RATING = 1500;
export const DEFAULT_RD = 350;
/** Hard floor; without it RD can drop below the noise level after many games. */
export const MIN_RD = 30;
/** Hard ceiling; clamps the prior on a fresh entrant. */
export const MAX_RD = 350;
/**
 * Days of inactivity that recover one full unit of RD. Glickman recommends
 * computing `RD = sqrt(RD_old² + c² × t)` where `c` calibrates how fast the
 * rating becomes uncertain over time. We pick `c² = 100` so 30 days of
 * inactivity adds ≈ 55 RD to a 0-RD player — a sensible "haven't drilled in a
 * month → be less confident" decay rate at single-user scale.
 */
export const RD_RECOVERY_C2 = 100;

export interface RatingState {
  rating: number;
  rd: number;
}

export function gFunction(rd: number): number {
  return 1 / Math.sqrt(1 + (3 * Q * Q * rd * rd) / (Math.PI * Math.PI));
}

export function expectedScore(
  subject: RatingState,
  opponent: RatingState,
): number {
  const g = gFunction(opponent.rd);
  const exponent = -g * (subject.rating - opponent.rating) / 400;
  return 1 / (1 + Math.pow(10, exponent));
}

/**
 * One-round Glicko-1 update for `subject` against `opponent`.
 * `score` is 1 for win (correct answer from user's perspective; failed attempt
 * from question's perspective), 0 for loss, in [0, 1] for partials.
 */
export function updateGlicko(
  subject: RatingState,
  opponent: RatingState,
  score: number,
): RatingState {
  const subjRd = clampRd(subject.rd);
  const oppRd = clampRd(opponent.rd);
  const g = gFunction(oppRd);
  const e = expectedScore(
    { rating: subject.rating, rd: subjRd },
    { rating: opponent.rating, rd: oppRd },
  );
  const dSquared = 1 / (Q * Q * g * g * e * (1 - e));
  const variance = 1 / (1 / (subjRd * subjRd) + 1 / dSquared);
  const newRating = subject.rating + variance * Q * g * (score - e);
  const newRd = Math.sqrt(variance);
  return {
    rating: newRating,
    rd: clampRd(newRd),
  };
}

/**
 * Pre-step recovery: increase RD to reflect inactivity since last update.
 * Glickman's formula: RD_new = sqrt(RD_old² + c² × t), capped at MAX_RD.
 */
export function recoverRd(rd: number, daysSinceLastUpdate: number): number {
  if (daysSinceLastUpdate <= 0) return clampRd(rd);
  const recovered = Math.sqrt(rd * rd + RD_RECOVERY_C2 * daysSinceLastUpdate);
  return clampRd(recovered);
}

function clampRd(rd: number): number {
  if (!Number.isFinite(rd)) return DEFAULT_RD;
  if (rd < MIN_RD) return MIN_RD;
  if (rd > MAX_RD) return MAX_RD;
  return rd;
}

/**
 * Predicted accuracy for a user with rating r and the question with rating q.
 * Uses the canonical logistic with no g(RD) modulation — for the *drill
 * allocator's* "pick questions near the desired difficulty" use case, the
 * point estimate is what we want; we leave the RD-aware version for displays
 * that need confidence intervals.
 */
export function predictedAccuracy(userRating: number, questionRating: number): number {
  return 1 / (1 + Math.pow(10, (questionRating - userRating) / 400));
}
