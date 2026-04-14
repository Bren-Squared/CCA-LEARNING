import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../lib/db";
import { schema } from "../lib/db";
import { MOCK_BLOOM_BAND } from "../lib/mock/allocate";
import {
  MOCK_PASS_SCALED,
  MOCK_SCALED_MAX,
  MOCK_SCALED_MIN,
  MockAttemptError,
  finishMockAttempt,
  getMockAttempt,
  listMockAttempts,
  rawToScaled,
  startMockAttempt,
  submitAnswer,
} from "../lib/mock/attempts";

const DRIZZLE_DIR = resolve(process.cwd(), "drizzle");

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

function seedFullBank(db: Db): void {
  db.transaction((tx) => {
    for (const [id, weight, idx] of [
      ["D1", 2700, 1],
      ["D2", 1800, 2],
      ["D3", 2000, 3],
      ["D4", 2000, 4],
      ["D5", 1500, 5],
    ] as const) {
      tx.insert(schema.domains)
        .values({ id, title: id, weightBps: weight, orderIndex: idx })
        .run();
      tx.insert(schema.taskStatements)
        .values({
          id: `${id}.1`,
          domainId: id,
          title: `${id} task`,
          knowledgeBullets: ["k"],
          skillsBullets: ["s"],
          orderIndex: 1,
        })
        .run();
    }
    for (let i = 1; i <= 6; i++) {
      tx.insert(schema.scenarios)
        .values({
          id: `S${i}`,
          title: `Scenario ${i}`,
          description: `d${i}`,
          orderIndex: i,
        })
        .run();
    }
    for (const dom of ["D1", "D2", "D3", "D4", "D5"]) {
      for (let s = 1; s <= 6; s++) {
        for (const bloom of MOCK_BLOOM_BAND) {
          for (let k = 0; k < 3; k++) {
            tx.insert(schema.questions)
              .values({
                id: randomUUID(),
                stem: `stem ${dom}-S${s}-L${bloom}-${k}`,
                options: ["a", "b", "c", "d"],
                correctIndex: 0,
                explanations: ["", "", "", ""],
                taskStatementId: `${dom}.1`,
                scenarioId: `S${s}`,
                difficulty: 3,
                bloomLevel: bloom,
                bloomJustification: "",
                source: "seed",
                status: "active",
              })
              .run();
          }
        }
      }
    }
  });
}

function answerAll(
  db: Db,
  attemptId: string,
  correctCount: number,
  now?: Date,
): void {
  const record = getMockAttempt(attemptId, { db, now });
  const qRows = db
    .select({ id: schema.questions.id, correctIndex: schema.questions.correctIndex })
    .from(schema.questions)
    .all();
  const correctById = new Map(qRows.map((r) => [r.id, r.correctIndex]));
  for (let i = 0; i < record.questionIds.length; i++) {
    const qid = record.questionIds[i];
    const correct = correctById.get(qid) ?? 0;
    const pick = i < correctCount ? correct : (correct + 1) % 4;
    submitAnswer(attemptId, i, pick, { db, now });
  }
}

describe("rawToScaled", () => {
  it("pins the pass boundary exactly at raw 0.72 → scaled 720", () => {
    expect(rawToScaled(0.72)).toBe(MOCK_PASS_SCALED);
  });

  it("maps the endpoints to 100 and 1000", () => {
    expect(rawToScaled(0)).toBe(MOCK_SCALED_MIN);
    expect(rawToScaled(1)).toBe(MOCK_SCALED_MAX);
  });

  it("is monotonic and produces mid-range values below the pass line", () => {
    expect(rawToScaled(0.36)).toBeGreaterThan(MOCK_SCALED_MIN);
    expect(rawToScaled(0.36)).toBeLessThan(MOCK_PASS_SCALED);
    expect(rawToScaled(0.72)).toBeLessThan(rawToScaled(0.86));
  });

  it("clamps out-of-range inputs", () => {
    expect(rawToScaled(-1)).toBe(MOCK_SCALED_MIN);
    expect(rawToScaled(2)).toBe(MOCK_SCALED_MAX);
  });
});

describe("startMockAttempt", () => {
  let ctx: ReturnType<typeof freshDb>;
  beforeEach(() => {
    ctx = freshDb();
    seedFullBank(ctx.db);
  });

  it("creates an in_progress attempt with 60 questions and 4 scenarios", () => {
    const attempt = startMockAttempt({ db: ctx.db, seed: 1 });
    expect(attempt.status).toBe("in_progress");
    expect(attempt.questionIds).toHaveLength(60);
    expect(attempt.scenarioIds).toHaveLength(4);
    expect(attempt.answers.every((a) => a === null)).toBe(true);
    expect(attempt.rawScore).toBeNull();
    expect(attempt.scaledScore).toBeNull();
  });

  it("records durationMs and reports positive remainingMs immediately after start", () => {
    const attempt = startMockAttempt({ db: ctx.db, seed: 1, durationMs: 60_000 });
    expect(attempt.durationMs).toBe(60_000);
    expect(attempt.remainingMs).toBeGreaterThan(0);
    expect(attempt.isExpired).toBe(false);
  });
});

describe("submitAnswer + resume", () => {
  let ctx: ReturnType<typeof freshDb>;
  beforeEach(() => {
    ctx = freshDb();
    seedFullBank(ctx.db);
  });

  it("persists an answer and a second read returns the same state (NFR2.2 autosave)", () => {
    const attempt = startMockAttempt({ db: ctx.db, seed: 10 });
    submitAnswer(attempt.id, 0, 2, { db: ctx.db });
    const reloaded = getMockAttempt(attempt.id, { db: ctx.db });
    expect(reloaded.answers[0]).toBe(2);
  });

  it("overwrites a prior answer on the same index", () => {
    const attempt = startMockAttempt({ db: ctx.db, seed: 11 });
    submitAnswer(attempt.id, 5, 1, { db: ctx.db });
    submitAnswer(attempt.id, 5, 3, { db: ctx.db });
    const reloaded = getMockAttempt(attempt.id, { db: ctx.db });
    expect(reloaded.answers[5]).toBe(3);
  });

  it("rejects out-of-range question or option indices", () => {
    const attempt = startMockAttempt({ db: ctx.db, seed: 12 });
    expect(() => submitAnswer(attempt.id, -1, 0, { db: ctx.db })).toThrow(
      MockAttemptError,
    );
    expect(() => submitAnswer(attempt.id, 100, 0, { db: ctx.db })).toThrow(
      MockAttemptError,
    );
    expect(() => submitAnswer(attempt.id, 0, 7, { db: ctx.db })).toThrow(
      MockAttemptError,
    );
  });

  it("auto-finishes as timeout when submitAnswer is called past the deadline", () => {
    const start = new Date("2026-04-01T10:00:00Z");
    const attempt = startMockAttempt({
      db: ctx.db,
      seed: 13,
      durationMs: 60_000,
      now: start,
    });
    const past = new Date(start.getTime() + 90_000);
    const result = submitAnswer(attempt.id, 0, 1, { db: ctx.db, now: past });
    expect(result.status).toBe("timeout");
    expect(result.scaledScore).not.toBeNull();
  });

  it("preserves answers across a simulated backend restart (reloading via a fresh Db handle)", () => {
    const sqlitePath = `${process.cwd()}/.tmp/mock-restart-${randomUUID()}.sqlite`;
    const realDb = new Database(sqlitePath);
    try {
      realDb.pragma("foreign_keys = ON");
      for (const stmt of allMigrationsSql().split("--> statement-breakpoint")) {
        const sql = stmt.trim();
        if (sql) realDb.exec(sql);
      }
      const d1 = drizzle(realDb, { schema }) as Db;
      seedFullBank(d1);
      const attempt = startMockAttempt({ db: d1, seed: 42, durationMs: 3_600_000 });
      submitAnswer(attempt.id, 0, 1, { db: d1 });
      submitAnswer(attempt.id, 1, 2, { db: d1 });
      realDb.close();

      const realDb2 = new Database(sqlitePath);
      const d2 = drizzle(realDb2, { schema }) as Db;
      const reloaded = getMockAttempt(attempt.id, { db: d2 });
      expect(reloaded.answers[0]).toBe(1);
      expect(reloaded.answers[1]).toBe(2);
      expect(reloaded.status).toBe("in_progress");
      expect(reloaded.remainingMs).toBeGreaterThan(0);
      realDb2.close();
    } finally {
      try {
        unlinkSync(sqlitePath);
      } catch {}
    }
  });
});

describe("finishMockAttempt", () => {
  let ctx: ReturnType<typeof freshDb>;
  beforeEach(() => {
    ctx = freshDb();
    seedFullBank(ctx.db);
  });

  it("computes raw score, scaled score, and pass flag when user scores above the pass line", () => {
    const attempt = startMockAttempt({ db: ctx.db, seed: 5 });
    answerAll(ctx.db, attempt.id, 50);
    const finished = finishMockAttempt(attempt.id, { db: ctx.db });
    expect(finished.status).toBe("submitted");
    expect(finished.rawScore).toBe(50);
    expect(finished.passed).toBe(true);
    expect(finished.scaledScore).toBeGreaterThanOrEqual(MOCK_PASS_SCALED);
  });

  it("marks not-passed when raw score is below 72%", () => {
    const attempt = startMockAttempt({ db: ctx.db, seed: 6 });
    answerAll(ctx.db, attempt.id, 40);
    const finished = finishMockAttempt(attempt.id, { db: ctx.db });
    expect(finished.rawScore).toBe(40);
    expect(finished.passed).toBe(false);
    expect(finished.scaledScore).toBeLessThan(MOCK_PASS_SCALED);
  });

  it("writes one progress event per question (60 total) with correct success flags", () => {
    const attempt = startMockAttempt({ db: ctx.db, seed: 7 });
    answerAll(ctx.db, attempt.id, 50);
    finishMockAttempt(attempt.id, { db: ctx.db });
    const events = ctx.db
      .select()
      .from(schema.progressEvents)
      .all();
    expect(events).toHaveLength(60);
    const successCount = events.filter((e) => e.success).length;
    expect(successCount).toBe(50);
    for (const e of events) {
      expect(e.kind).toBe("mcq_answer");
      const payload = e.payload as Record<string, unknown>;
      expect(payload.source).toBe("mock_exam");
      expect(payload.attemptId).toBe(attempt.id);
    }
  });

  it("treats unanswered (null) items as incorrect", () => {
    const attempt = startMockAttempt({ db: ctx.db, seed: 8 });
    const finished = finishMockAttempt(attempt.id, { db: ctx.db });
    expect(finished.rawScore).toBe(0);
    expect(finished.passed).toBe(false);
  });

  it("is idempotent: calling finish on a submitted attempt returns it unchanged", () => {
    const attempt = startMockAttempt({ db: ctx.db, seed: 9 });
    answerAll(ctx.db, attempt.id, 45);
    const first = finishMockAttempt(attempt.id, { db: ctx.db });
    const again = finishMockAttempt(attempt.id, { db: ctx.db });
    expect(again.rawScore).toBe(first.rawScore);
    expect(again.scaledScore).toBe(first.scaledScore);
    expect(again.finishedAt).toBe(first.finishedAt);
    const events = ctx.db.select().from(schema.progressEvents).all();
    expect(events).toHaveLength(60);
  });

  it("records timeout status when the deadline has passed", () => {
    const start = new Date("2026-04-01T10:00:00Z");
    const attempt = startMockAttempt({
      db: ctx.db,
      seed: 20,
      durationMs: 60_000,
      now: start,
    });
    answerAll(ctx.db, attempt.id, 30, start);
    const past = new Date(start.getTime() + 90_000);
    const finished = finishMockAttempt(attempt.id, { db: ctx.db, now: past });
    expect(finished.status).toBe("timeout");
    expect(finished.scaledScore).not.toBeNull();
  });
});

describe("listMockAttempts", () => {
  it("orders attempts newest-first", () => {
    const ctx = freshDb();
    seedFullBank(ctx.db);
    const a = startMockAttempt({
      db: ctx.db,
      seed: 1,
      now: new Date("2026-04-01T10:00:00Z"),
    });
    const b = startMockAttempt({
      db: ctx.db,
      seed: 2,
      now: new Date("2026-04-02T10:00:00Z"),
    });
    const list = listMockAttempts({ db: ctx.db });
    expect(list.map((r) => r.id)).toEqual([b.id, a.id]);
  });
});
