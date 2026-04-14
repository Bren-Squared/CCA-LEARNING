import { describe, expect, it } from "vitest";
import {
  applyGrade,
  DEFAULT_EASE_FACTOR,
  EASY_INTERVAL_BONUS,
  FAILURE_INTERVAL_DAYS,
  FIRST_GRADUATED_INTERVAL_DAYS,
  gradeIsSuccess,
  GRADE_QUALITY,
  MIN_EASE_FACTOR,
  SECOND_GRADUATED_INTERVAL_DAYS,
  type Sm2State,
} from "../lib/progress/sm2";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 3, 13, 12, 0, 0); // 2026-04-13T12:00:00Z

function fresh(): Sm2State {
  return { easeFactor: DEFAULT_EASE_FACTOR, intervalDays: 0 };
}

describe("GRADE_QUALITY map", () => {
  it("assigns SM-2 quality values: 0/3/4/5", () => {
    expect(GRADE_QUALITY.again).toBe(0);
    expect(GRADE_QUALITY.hard).toBe(3);
    expect(GRADE_QUALITY.good).toBe(4);
    expect(GRADE_QUALITY.easy).toBe(5);
  });
});

describe("gradeIsSuccess", () => {
  it("again → failure; hard/good/easy → success", () => {
    expect(gradeIsSuccess("again")).toBe(false);
    expect(gradeIsSuccess("hard")).toBe(true);
    expect(gradeIsSuccess("good")).toBe(true);
    expect(gradeIsSuccess("easy")).toBe(true);
  });
});

describe("applyGrade — graduation steps", () => {
  it("fresh card + good → interval = 1 day", () => {
    const out = applyGrade(fresh(), "good", { now: NOW });
    expect(out.intervalDays).toBe(FIRST_GRADUATED_INTERVAL_DAYS);
    expect(out.nextDueAt).toBe(NOW + DAY_MS);
  });

  it("interval = 1 + good → interval = 6 days", () => {
    const out = applyGrade(
      { easeFactor: DEFAULT_EASE_FACTOR, intervalDays: 1 },
      "good",
      { now: NOW },
    );
    expect(out.intervalDays).toBe(SECOND_GRADUATED_INTERVAL_DAYS);
    expect(out.nextDueAt).toBe(NOW + 6 * DAY_MS);
  });

  it("interval = 6 + good → round(6 × EF)", () => {
    const prev = { easeFactor: DEFAULT_EASE_FACTOR, intervalDays: 6 };
    const out = applyGrade(prev, "good", { now: NOW });
    // EF doesn't change on q=4; next = round(6 × 2.5) = 15
    expect(out.intervalDays).toBe(15);
    expect(out.easeFactor).toBeCloseTo(DEFAULT_EASE_FACTOR, 10);
  });
});

describe("applyGrade — failure resets", () => {
  it("again on a graduated card → interval = 1 day", () => {
    const prev = { easeFactor: 2.4, intervalDays: 30 };
    const out = applyGrade(prev, "again", { now: NOW });
    expect(out.intervalDays).toBe(FAILURE_INTERVAL_DAYS);
    expect(out.nextDueAt).toBe(NOW + DAY_MS);
  });

  it("again on a fresh card → still 1 day", () => {
    const out = applyGrade(fresh(), "again", { now: NOW });
    expect(out.intervalDays).toBe(FAILURE_INTERVAL_DAYS);
  });

  it("again still applies the EF penalty per SM-2 formula", () => {
    // q=0: efDelta = 0.1 - 5*(0.08 + 5*0.02) = 0.1 - 5*0.18 = 0.1 - 0.9 = -0.8
    // Starting from default 2.5, one failure → 1.7 (still above 1.3 floor)
    const out = applyGrade(fresh(), "again", { now: NOW });
    expect(out.easeFactor).toBeCloseTo(DEFAULT_EASE_FACTOR - 0.8, 10);
  });

  it("EF clamps to 1.3 after repeated failures", () => {
    // Two consecutive failures from 2.5: 2.5 → 1.7 → 0.9 (clamped to 1.3)
    let st = fresh();
    const first = applyGrade(st, "again", { now: NOW });
    st = { easeFactor: first.easeFactor, intervalDays: first.intervalDays };
    const second = applyGrade(st, "again", { now: NOW });
    expect(second.easeFactor).toBe(MIN_EASE_FACTOR);
  });
});

describe("applyGrade — ease factor transitions", () => {
  it("good (q=4) leaves EF unchanged (delta = 0)", () => {
    // q=4: efDelta = 0.1 - 1*(0.08 + 1*0.02) = 0.1 - 0.1 = 0
    const out = applyGrade(fresh(), "good", { now: NOW });
    expect(out.easeFactor).toBeCloseTo(DEFAULT_EASE_FACTOR, 10);
  });

  it("easy (q=5) bumps EF by +0.1", () => {
    // q=5: efDelta = 0.1 - 0 = 0.1
    const out = applyGrade(fresh(), "easy", { now: NOW });
    expect(out.easeFactor).toBeCloseTo(DEFAULT_EASE_FACTOR + 0.1, 10);
  });

  it("hard (q=3) drops EF by -0.14", () => {
    // q=3: efDelta = 0.1 - 2*(0.08 + 2*0.02) = 0.1 - 2*0.12 = 0.1 - 0.24 = -0.14
    const out = applyGrade(fresh(), "hard", { now: NOW });
    expect(out.easeFactor).toBeCloseTo(DEFAULT_EASE_FACTOR - 0.14, 10);
  });

  it("EF clamps at 1.3 after repeated hard grades", () => {
    let state: Sm2State = { easeFactor: DEFAULT_EASE_FACTOR, intervalDays: 6 };
    // 20 consecutive hards: -0.14 × 20 = -2.8, would drop below 1.3
    for (let i = 0; i < 20; i++) {
      const out = applyGrade(state, "hard", { now: NOW });
      state = { easeFactor: out.easeFactor, intervalDays: out.intervalDays };
    }
    expect(state.easeFactor).toBe(MIN_EASE_FACTOR);
  });

  it("EF never exceeds ~2.5 under 'good' (stable)", () => {
    let state: Sm2State = fresh();
    for (let i = 0; i < 10; i++) {
      const out = applyGrade(state, "good", { now: NOW });
      state = { easeFactor: out.easeFactor, intervalDays: out.intervalDays };
    }
    expect(state.easeFactor).toBeCloseTo(DEFAULT_EASE_FACTOR, 10);
  });
});

describe("applyGrade — easy bonus", () => {
  it("easy on a card with intervalDays > 1 applies the 1.3× interval bonus", () => {
    const prev = { easeFactor: DEFAULT_EASE_FACTOR, intervalDays: 6 };
    const out = applyGrade(prev, "easy", { now: NOW });
    // EF 2.5 → 2.6 on q=5, interval = round(6 × 2.6) = 16, × 1.3 = round(20.8) = 21
    const base = Math.round(6 * (DEFAULT_EASE_FACTOR + 0.1));
    expect(out.intervalDays).toBe(Math.round(base * EASY_INTERVAL_BONUS));
  });

  it("easy on a fresh card does NOT apply the bonus (graduation still 1 day)", () => {
    const out = applyGrade(fresh(), "easy", { now: NOW });
    expect(out.intervalDays).toBe(FIRST_GRADUATED_INTERVAL_DAYS);
  });

  it("easy on intervalDays=1 does NOT apply the bonus (still graduating)", () => {
    const out = applyGrade(
      { easeFactor: DEFAULT_EASE_FACTOR, intervalDays: 1 },
      "easy",
      { now: NOW },
    );
    // Second graduation step is 6 regardless of bonus (prev.intervalDays is 1,
    // not > 1, so bonus skipped). Easy still bumps EF though.
    expect(out.intervalDays).toBe(SECOND_GRADUATED_INTERVAL_DAYS);
    expect(out.easeFactor).toBeCloseTo(DEFAULT_EASE_FACTOR + 0.1, 10);
  });
});

describe("applyGrade — dueAt is anchored to `now`, not prior dueAt", () => {
  it("late review does not compound: next dueAt = now + intervalDays", () => {
    const prev = { easeFactor: DEFAULT_EASE_FACTOR, intervalDays: 6 };
    const out = applyGrade(prev, "good", { now: NOW });
    expect(out.nextDueAt).toBe(NOW + out.intervalDays * DAY_MS);
  });
});

describe("applyGrade — canonical SM-2 example walk", () => {
  it("good×3 sequence from a fresh card follows documented intervals", () => {
    // Step 1: fresh → good → interval 1
    const s1 = applyGrade(fresh(), "good", { now: NOW });
    expect(s1.intervalDays).toBe(1);
    // Step 2: interval 1 → good → interval 6
    const s2 = applyGrade(
      { easeFactor: s1.easeFactor, intervalDays: s1.intervalDays },
      "good",
      { now: NOW + DAY_MS },
    );
    expect(s2.intervalDays).toBe(6);
    // Step 3: interval 6 → good → round(6 × EF)
    const s3 = applyGrade(
      { easeFactor: s2.easeFactor, intervalDays: s2.intervalDays },
      "good",
      { now: NOW + 7 * DAY_MS },
    );
    expect(s3.intervalDays).toBe(Math.round(6 * s3.easeFactor));
  });

  it("failure mid-stream restarts interval but remembers EF penalty", () => {
    // Build up a card to intervalDays=15 via good×3
    let st: Sm2State = fresh();
    for (let i = 0; i < 3; i++) {
      const out = applyGrade(st, "good", { now: NOW + i * DAY_MS });
      st = { easeFactor: out.easeFactor, intervalDays: out.intervalDays };
    }
    expect(st.intervalDays).toBe(15);
    const fail = applyGrade(st, "again", { now: NOW + 100 * DAY_MS });
    expect(fail.intervalDays).toBe(FAILURE_INTERVAL_DAYS);
    // EF was 2.5 (good×3 at q=4 leaves it unchanged), one 'again' delta -0.8
    expect(fail.easeFactor).toBeCloseTo(DEFAULT_EASE_FACTOR - 0.8, 10);
  });
});
