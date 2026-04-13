/**
 * Decay-weighted mastery math (RD1 + OD2).
 *
 * Pure functions — no DB coupling, so these are easy to unit-test in isolation.
 *
 * Bloom levels are 1..6 (Remember, Understand, Apply, Analyze, Evaluate, Create).
 * OD2 weights are {1, 2, 4, 8, 16, 32}; sum = 63.
 *
 * A level is considered *mastered* when BOTH:
 *   score ≥ 0.80 (i.e. ≥ 80%)
 *   itemCount ≥ 5 (raw event floor, prevents a single lucky answer flipping state)
 *
 * "Recency" comes from the decay: newer events have weight ~1.0, older events
 * decay exponentially by half-life. Half-life is user-tunable (OD4 / review
 * intensity setting) and defaults to 14 days.
 */

export const BLOOM_LEVELS = [1, 2, 3, 4, 5, 6] as const;
export type BloomLevel = (typeof BLOOM_LEVELS)[number];

export const OD2_BLOOM_WEIGHTS: Record<BloomLevel, number> = {
  1: 1,
  2: 2,
  3: 4,
  4: 8,
  5: 16,
  6: 32,
};

export const OD2_WEIGHT_TOTAL = 63; // sum of OD2_BLOOM_WEIGHTS

export const MASTERY_SCORE_THRESHOLD = 0.8;
export const MASTERY_ITEM_FLOOR = 5;

export const DEFAULT_HALF_LIFE_DAYS = 14;

export interface ScoredEvent {
  success: boolean;
  /** milliseconds since epoch — same shape as progress_events.ts */
  ts: number;
}

export interface LevelScore {
  /** 0..1 — decay-weighted success rate */
  score: number;
  /** raw event count (NOT decay-weighted) — the sample-size floor */
  itemCount: number;
}

/**
 * Exponential decay weight: events `ageDays` old contribute `0.5^(age/halfLife)`.
 * Clamped at ageDays=0 so future-dated events (clock skew) don't exceed 1.0.
 */
export function decayWeight(ageDays: number, halfLifeDays: number): number {
  const age = Math.max(0, ageDays);
  return Math.pow(0.5, age / halfLifeDays);
}

/**
 * Compute a level score for one (task_statement_id, bloom_level) pair.
 *
 * Zero events → score=0, itemCount=0. Mastery check then fails on both gates.
 */
export function computeLevelScore(
  events: ScoredEvent[],
  opts: { now: number; halfLifeDays?: number },
): LevelScore {
  const halfLife = opts.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS;
  if (events.length === 0) return { score: 0, itemCount: 0 };

  let weightedSuccess = 0;
  let weightedTotal = 0;
  for (const e of events) {
    const ageMs = opts.now - e.ts;
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    const w = decayWeight(ageDays, halfLife);
    weightedTotal += w;
    if (e.success) weightedSuccess += w;
  }

  // weightedTotal can only be 0 if every event decayed to 0 — mathematically
  // impossible for finite positive half-life, but guard anyway to keep NaN out.
  const score = weightedTotal > 0 ? weightedSuccess / weightedTotal : 0;
  return { score, itemCount: events.length };
}

export function isMastered(level: LevelScore): boolean {
  return (
    level.score >= MASTERY_SCORE_THRESHOLD &&
    level.itemCount >= MASTERY_ITEM_FLOOR
  );
}

/**
 * OD2-weighted summary across Bloom levels for a single task statement.
 * Input is level → score (0..1). Missing levels count as 0.
 * Returns 0..100.
 */
export function taskStatementSummary(
  levelScores: Partial<Record<BloomLevel, number>>,
): number {
  let weighted = 0;
  for (const level of BLOOM_LEVELS) {
    const s = levelScores[level] ?? 0;
    weighted += OD2_BLOOM_WEIGHTS[level] * s;
  }
  return (weighted / OD2_WEIGHT_TOTAL) * 100;
}

/**
 * Domain-level rollup: simple average of TS summaries within the domain.
 * Per spec, the exam-domain weighting (weight_bps) applies to mock-exam
 * composition, not to mastery display — so this is an unweighted mean.
 * Returns 0..100. Empty input → 0.
 */
export function domainSummary(tsSummaries: number[]): number {
  if (tsSummaries.length === 0) return 0;
  const sum = tsSummaries.reduce((a, b) => a + b, 0);
  return sum / tsSummaries.length;
}
