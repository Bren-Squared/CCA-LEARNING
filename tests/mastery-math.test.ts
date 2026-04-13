import { describe, expect, it } from "vitest";
import {
  BLOOM_LEVELS,
  DEFAULT_HALF_LIFE_DAYS,
  MASTERY_ITEM_FLOOR,
  MASTERY_SCORE_THRESHOLD,
  OD2_BLOOM_WEIGHTS,
  OD2_WEIGHT_TOTAL,
  computeLevelScore,
  decayWeight,
  domainSummary,
  isMastered,
  taskStatementSummary,
} from "../lib/progress/mastery";

const DAY_MS = 1000 * 60 * 60 * 24;
const NOW = Date.UTC(2026, 3, 13); // stable "now" for deterministic math

describe("OD2 Bloom weights", () => {
  it("sum to 63", () => {
    const sum = BLOOM_LEVELS.reduce((a, l) => a + OD2_BLOOM_WEIGHTS[l], 0);
    expect(sum).toBe(OD2_WEIGHT_TOTAL);
    expect(sum).toBe(63);
  });

  it("double at each level (geometric progression)", () => {
    for (let i = 1; i < BLOOM_LEVELS.length; i++) {
      const prev = OD2_BLOOM_WEIGHTS[BLOOM_LEVELS[i - 1]];
      const cur = OD2_BLOOM_WEIGHTS[BLOOM_LEVELS[i]];
      expect(cur).toBe(prev * 2);
    }
  });
});

describe("decayWeight", () => {
  it("returns 1 for freshly-stamped events", () => {
    expect(decayWeight(0, 14)).toBe(1);
  });

  it("returns 0.5 at exactly one half-life", () => {
    expect(decayWeight(14, 14)).toBeCloseTo(0.5, 10);
  });

  it("returns 0.25 at two half-lives", () => {
    expect(decayWeight(28, 14)).toBeCloseTo(0.25, 10);
  });

  it("clamps negative age (clock skew) to 1", () => {
    expect(decayWeight(-5, 14)).toBe(1);
  });
});

describe("computeLevelScore", () => {
  it("returns zero state for no events", () => {
    expect(computeLevelScore([], { now: NOW })).toEqual({
      score: 0,
      itemCount: 0,
    });
  });

  it("scores all-correct recent events at ~1.0", () => {
    const events = Array.from({ length: 10 }, (_, i) => ({
      success: true,
      ts: NOW - i * DAY_MS, // last 10 days
    }));
    const result = computeLevelScore(events, { now: NOW });
    expect(result.score).toBeCloseTo(1, 10);
    expect(result.itemCount).toBe(10);
  });

  it("scores all-wrong recent events at 0", () => {
    const events = Array.from({ length: 10 }, (_, i) => ({
      success: false,
      ts: NOW - i * DAY_MS,
    }));
    const result = computeLevelScore(events, { now: NOW });
    expect(result.score).toBe(0);
    expect(result.itemCount).toBe(10);
  });

  it("weights recent events more than old ones", () => {
    // Recent wins + ancient losses → score well above raw 50%
    const events = [
      { success: true, ts: NOW }, // w=1
      { success: true, ts: NOW - DAY_MS }, // w≈0.95
      { success: false, ts: NOW - 60 * DAY_MS }, // w=0.5^(60/14) ≈ 0.0508
      { success: false, ts: NOW - 90 * DAY_MS }, // w=0.5^(90/14) ≈ 0.012
    ];
    const result = computeLevelScore(events, { now: NOW });
    expect(result.score).toBeGreaterThan(0.95);
    expect(result.itemCount).toBe(4);
  });

  it("honors a custom half-life", () => {
    // Same event 7 days old: with halfLife=7 → w=0.5, with halfLife=14 → w≈0.707
    const events = [{ success: true, ts: NOW - 7 * DAY_MS }];
    const r7 = computeLevelScore(events, { now: NOW, halfLifeDays: 7 });
    const r14 = computeLevelScore(events, { now: NOW, halfLifeDays: 14 });
    expect(r7.score).toBeCloseTo(1, 10); // single event, still 1/1
    expect(r14.score).toBeCloseTo(1, 10);
    // Where half-life actually shifts the needle: mix of old/new events
    const mixed = [
      { success: true, ts: NOW },
      { success: false, ts: NOW - 7 * DAY_MS },
    ];
    const short = computeLevelScore(mixed, { now: NOW, halfLifeDays: 7 });
    const long = computeLevelScore(mixed, { now: NOW, halfLifeDays: 14 });
    // Shorter half-life → old failure decays faster → higher score
    expect(short.score).toBeGreaterThan(long.score);
  });

  it("uses default half-life when not provided", () => {
    const events = [{ success: false, ts: NOW - DEFAULT_HALF_LIFE_DAYS * DAY_MS }];
    const result = computeLevelScore(events, { now: NOW });
    // Single failing event regardless of decay → score 0
    expect(result.score).toBe(0);
    expect(result.itemCount).toBe(1);
  });
});

describe("isMastered", () => {
  it("requires both score ≥ 0.80 AND itemCount ≥ 5", () => {
    expect(isMastered({ score: 0.85, itemCount: 5 })).toBe(true);
    expect(isMastered({ score: 0.8, itemCount: 5 })).toBe(true); // edge: exactly 0.80
    expect(isMastered({ score: 0.79, itemCount: 100 })).toBe(false);
    expect(isMastered({ score: 1, itemCount: 4 })).toBe(false); // below floor
    expect(isMastered({ score: 0, itemCount: 0 })).toBe(false);
  });

  it("uses the exported threshold constants", () => {
    expect(MASTERY_SCORE_THRESHOLD).toBe(0.8);
    expect(MASTERY_ITEM_FLOOR).toBe(5);
  });
});

describe("taskStatementSummary", () => {
  it("returns 0 when no levels have progress", () => {
    expect(taskStatementSummary({})).toBe(0);
  });

  it("returns 100 when every level is at 1.0", () => {
    expect(
      taskStatementSummary({ 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1 }),
    ).toBeCloseTo(100, 10);
  });

  it("weights level 6 heaviest (32/63 ≈ 50.79%)", () => {
    const only6 = taskStatementSummary({ 6: 1 });
    expect(only6).toBeCloseTo((32 / 63) * 100, 10);
  });

  it("weights level 1 lightest (1/63 ≈ 1.59%)", () => {
    const only1 = taskStatementSummary({ 1: 1 });
    expect(only1).toBeCloseTo((1 / 63) * 100, 10);
  });

  it("treats missing levels as 0", () => {
    const a = taskStatementSummary({ 1: 1, 2: 1 });
    const b = taskStatementSummary({ 1: 1, 2: 1, 3: 0, 4: 0, 5: 0, 6: 0 });
    expect(a).toBeCloseTo(b, 10);
  });
});

describe("domainSummary", () => {
  it("returns 0 for no task statements", () => {
    expect(domainSummary([])).toBe(0);
  });

  it("is an unweighted mean of TS summaries", () => {
    expect(domainSummary([50, 50, 100])).toBeCloseTo(200 / 3, 10);
    expect(domainSummary([0, 100])).toBe(50);
  });
});
