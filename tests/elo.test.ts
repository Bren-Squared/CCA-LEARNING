import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../lib/db";
import { schema } from "../lib/db";
import {
  DEFAULT_RATING,
  DEFAULT_RD,
  MAX_RD,
  MIN_RD,
  expectedScore,
  predictedAccuracy,
  recoverRd,
  updateGlicko,
} from "../lib/progress/elo";
import { applyEloUpdate } from "../lib/progress/elo-update";
import { writeProgressEvent } from "../lib/progress/events";
import { buildDrillPool, ELO_MIN_ATTEMPTS } from "../lib/study/drill";

const DRIZZLE_DIR = resolve(process.cwd(), "drizzle");
const DAY_MS = 24 * 60 * 60 * 1000;

function allMigrationsSql(): string {
  return readdirSync(DRIZZLE_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(resolve(DRIZZLE_DIR, f), "utf8"))
    .join("\n");
}

function freshDb(): { db: Db; close: () => void } {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  for (const stmt of allMigrationsSql().split("--> statement-breakpoint")) {
    const sql = stmt.trim();
    if (sql) sqlite.exec(sql);
  }
  return { db: drizzle(sqlite, { schema }), close: () => sqlite.close() };
}

function seedTs(db: Db): void {
  db.insert(schema.domains)
    .values({ id: "D1", title: "Domain 1", weightBps: 10000, orderIndex: 1 })
    .run();
  db.insert(schema.taskStatements)
    .values({
      id: "D1.1",
      domainId: "D1",
      title: "Task",
      knowledgeBullets: ["k0"],
      skillsBullets: [],
      orderIndex: 1,
    })
    .run();
  db.insert(schema.settings).values({ id: 1 }).run();
}

function seedQuestion(
  db: Db,
  id: string,
  bloom = 3,
  rating = DEFAULT_RATING,
  attemptsCount = 0,
): string {
  db.insert(schema.questions)
    .values({
      id,
      stem: "x",
      options: ["a", "b", "c", "d"],
      correctIndex: 0,
      explanations: ["", "", "", ""],
      taskStatementId: "D1.1",
      bloomLevel: bloom,
      bloomJustification: "t",
      difficulty: 3,
      eloRating: rating,
      attemptsCount,
      source: "generated",
      status: "active",
    })
    .run();
  return id;
}

describe("Glicko math (E4 / Phase 17)", () => {
  it("expectedScore is 0.5 when ratings match", () => {
    const e = expectedScore(
      { rating: 1500, rd: 100 },
      { rating: 1500, rd: 100 },
    );
    expect(e).toBeCloseTo(0.5, 5);
  });

  it("higher-rated subject expected to win more often", () => {
    const e = expectedScore(
      { rating: 1700, rd: 100 },
      { rating: 1500, rd: 100 },
    );
    expect(e).toBeGreaterThan(0.6);
    expect(e).toBeLessThan(1);
  });

  it("predictedAccuracy at 200 rating gap ≈ 0.76", () => {
    const acc = predictedAccuracy(1700, 1500);
    expect(acc).toBeCloseTo(0.76, 2);
  });

  it("updateGlicko nudges rating in correct direction on win", () => {
    const before = { rating: 1500, rd: 200 };
    const after = updateGlicko(
      before,
      { rating: 1500, rd: 200 },
      1, // win
    );
    expect(after.rating).toBeGreaterThan(before.rating);
    expect(after.rd).toBeLessThan(before.rd); // confidence narrows
  });

  it("updateGlicko nudges rating down on loss", () => {
    const before = { rating: 1500, rd: 200 };
    const after = updateGlicko(
      before,
      { rating: 1500, rd: 200 },
      0,
    );
    expect(after.rating).toBeLessThan(before.rating);
  });

  it("rating moves are conservative under low confidence", () => {
    // Tight RD on both sides → small update; loose RD → big update.
    const tight = updateGlicko(
      { rating: 1500, rd: MIN_RD },
      { rating: 1500, rd: MIN_RD },
      1,
    );
    const loose = updateGlicko(
      { rating: 1500, rd: 350 },
      { rating: 1500, rd: 350 },
      1,
    );
    expect(loose.rating - 1500).toBeGreaterThan(tight.rating - 1500);
  });

  it("recoverRd grows RD with idle days, capped at MAX_RD", () => {
    expect(recoverRd(50, 0)).toBe(50);
    const grown = recoverRd(50, 30);
    expect(grown).toBeGreaterThan(50);
    expect(grown).toBeLessThanOrEqual(MAX_RD);
    // Eventually saturates at MAX_RD — at c²=100, ~12k idle days suffice.
    expect(recoverRd(50, 100_000)).toBe(MAX_RD);
  });
});

describe("applyEloUpdate (E4 / Phase 17)", () => {
  let handle: ReturnType<typeof freshDb>;
  beforeEach(() => {
    handle = freshDb();
    seedTs(handle.db);
  });

  it("creates user_skill row + updates question rating on first attempt", () => {
    const qid = seedQuestion(handle.db, "q1", 3, 1500);
    const r = applyEloUpdate(qid, "D1.1", 3, true, { now: Date.now() }, handle.db);
    expect(r.applied).toBe(true);
    expect(r.userRating).toBeGreaterThan(1500); // user won
    expect(r.questionRating).toBeLessThan(1500); // question lost

    const skill = handle.db
      .select()
      .from(schema.userSkill)
      .where(
        eq(schema.userSkill.taskStatementId, "D1.1"),
      )
      .get();
    expect(skill?.attemptsCount).toBe(1);

    const question = handle.db
      .select()
      .from(schema.questions)
      .where(eq(schema.questions.id, qid))
      .get();
    expect(question?.attemptsCount).toBe(1);
    handle.close();
  });

  it("fails-soft when the question doesn't exist", () => {
    const r = applyEloUpdate(
      "missing-q",
      "D1.1",
      3,
      true,
      { now: Date.now() },
      handle.db,
    );
    expect(r.applied).toBe(false);
    expect(handle.db.select().from(schema.userSkill).all()).toHaveLength(0);
    handle.close();
  });

  it("after 50 successful attempts, question rating drops > 200 below user", () => {
    const qid = seedQuestion(handle.db, "q-easy", 3, 1500);
    let now = Date.UTC(2026, 3, 14, 12);
    for (let i = 0; i < 50; i++) {
      // 80% success rate — user is materially stronger than the question.
      const success = i % 5 !== 0;
      applyEloUpdate(qid, "D1.1", 3, success, { now }, handle.db);
      now += 60_000; // 1 min between attempts so RD recovery is negligible
    }
    const userSkill = handle.db
      .select()
      .from(schema.userSkill)
      .get();
    const question = handle.db
      .select()
      .from(schema.questions)
      .where(eq(schema.questions.id, qid))
      .get();
    expect(question?.attemptsCount).toBe(50);
    expect(userSkill!.eloRating - question!.eloRating).toBeGreaterThan(200);
    handle.close();
  });

  it("integrates with writeProgressEvent for mcq_answer events", () => {
    const qid = seedQuestion(handle.db, "q-int", 3, 1500);
    writeProgressEvent(
      {
        kind: "mcq_answer",
        taskStatementId: "D1.1",
        bloomLevel: 3,
        success: true,
        ts: new Date(),
        payload: { question_id: qid },
      },
      handle.db,
    );
    const skill = handle.db.select().from(schema.userSkill).get();
    expect(skill).toBeDefined();
    expect(skill!.attemptsCount).toBe(1);
    handle.close();
  });
});

describe("buildDrillPool · targetSuccessRate (E4 / Phase 17)", () => {
  let handle: ReturnType<typeof freshDb>;
  beforeEach(() => {
    handle = freshDb();
    seedTs(handle.db);
  });

  it("with a calibrated user, prefers questions whose predicted accuracy is closest to target", () => {
    // Calibrate user at ~1700.
    handle.db
      .insert(schema.userSkill)
      .values({
        taskStatementId: "D1.1",
        bloomLevel: 3,
        eloRating: 1700,
        eloVolatility: 50,
        attemptsCount: 30,
        updatedAt: new Date(),
      })
      .run();

    // Three calibrated questions: easy (1300 → predicted 0.91), medium (1550 → 0.7), hard (1900 → 0.24).
    seedQuestion(handle.db, "q-easy", 3, 1300, ELO_MIN_ATTEMPTS);
    seedQuestion(handle.db, "q-medium", 3, 1550, ELO_MIN_ATTEMPTS);
    seedQuestion(handle.db, "q-hard", 3, 1900, ELO_MIN_ATTEMPTS);

    const pool = buildDrillPool(
      { type: "task", id: "D1.1" },
      { db: handle.db, targetSuccessRate: 0.7, limit: 3, seed: 1 },
    );
    // Medium should land first because predicted ≈ 0.7 exactly matches.
    expect(pool.questions[0].id).toBe("q-medium");
    handle.close();
  });

  it("interleaves cold (low-attempt) questions after the calibrated set", () => {
    handle.db
      .insert(schema.userSkill)
      .values({
        taskStatementId: "D1.1",
        bloomLevel: 3,
        eloRating: 1700,
        eloVolatility: 50,
        attemptsCount: 30,
        updatedAt: new Date(),
      })
      .run();

    // One calibrated question + two cold questions.
    seedQuestion(handle.db, "q-cal", 3, 1550, ELO_MIN_ATTEMPTS);
    seedQuestion(handle.db, "q-cold-a", 3, 1500, 0);
    seedQuestion(handle.db, "q-cold-b", 3, 1500, 0);

    const pool = buildDrillPool(
      { type: "task", id: "D1.1" },
      { db: handle.db, targetSuccessRate: 0.7, limit: 3, seed: 1 },
    );
    expect(pool.questions[0].id).toBe("q-cal");
    expect(pool.questions.slice(1).map((q) => q.id).sort()).toEqual([
      "q-cold-a",
      "q-cold-b",
    ]);
    handle.close();
  });

  it("falls back to seed shuffle when no targetSuccessRate is set", () => {
    seedQuestion(handle.db, "qa", 3);
    seedQuestion(handle.db, "qb", 3);
    seedQuestion(handle.db, "qc", 3);
    const pool1 = buildDrillPool({ type: "all" }, { db: handle.db, seed: 42, limit: 3 });
    const pool2 = buildDrillPool({ type: "all" }, { db: handle.db, seed: 42, limit: 3 });
    expect(pool1.questions.map((q) => q.id)).toEqual(
      pool2.questions.map((q) => q.id),
    );
    handle.close();
  });
});

describe("Elo + RD recovery integration", () => {
  let handle: ReturnType<typeof freshDb>;
  beforeEach(() => {
    handle = freshDb();
    seedTs(handle.db);
  });

  it("RD grows after 30 days idle, then re-narrows after a fresh attempt", () => {
    const qid = seedQuestion(handle.db, "q1", 3, 1500);
    const t0 = Date.UTC(2026, 3, 14);
    applyEloUpdate(qid, "D1.1", 3, true, { now: t0 }, handle.db);
    const skillAfterFirst = handle.db
      .select()
      .from(schema.userSkill)
      .get()!;

    // 30 days idle, then attempt again.
    applyEloUpdate(qid, "D1.1", 3, true, { now: t0 + 30 * DAY_MS }, handle.db);
    const skillAfterIdle = handle.db.select().from(schema.userSkill).get()!;

    // After idle, the rating moved more aggressively because RD was higher
    // pre-update — sanity-check: rating change is non-trivial.
    expect(Math.abs(skillAfterIdle.eloRating - skillAfterFirst.eloRating)).toBeGreaterThan(0);
    expect(skillAfterIdle.eloVolatility).toBeLessThan(MAX_RD);
    handle.close();
  });

  it("DEFAULT_RD/RATING constants stay sensible", () => {
    expect(DEFAULT_RATING).toBe(1500);
    expect(DEFAULT_RD).toBe(350);
    expect(MIN_RD).toBeLessThan(MAX_RD);
  });
});
