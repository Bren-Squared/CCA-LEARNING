import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../lib/db";
import { schema } from "../lib/db";
import { writeProgressEvent } from "../lib/progress/events";
import {
  applyMcqAttempt,
  countDueMcqs,
  listDueMcqs,
} from "../lib/study/mcq-srs";
import { buildDrillPool } from "../lib/study/drill";

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

function seedDomainAndTs(db: Db): { domainId: string; tsId: string } {
  db.insert(schema.domains)
    .values({ id: "D1", title: "Agentic Architecture", weightBps: 2700, orderIndex: 1 })
    .run();
  db.insert(schema.taskStatements)
    .values({
      id: "D1.1",
      domainId: "D1",
      title: "Agentic loops",
      knowledgeBullets: ["a", "b"],
      skillsBullets: ["c"],
      orderIndex: 1,
    })
    .run();
  db.insert(schema.settings).values({ id: 1 }).run();
  return { domainId: "D1", tsId: "D1.1" };
}

function seedQuestion(db: Db, tsId: string, id?: string): string {
  const qid = id ?? randomUUID();
  db.insert(schema.questions)
    .values({
      id: qid,
      stem: "What is X?",
      options: ["a", "b", "c", "d"],
      correctIndex: 0,
      explanations: ["w", "x", "y", "z"],
      taskStatementId: tsId,
      difficulty: 3,
      bloomLevel: 3,
      bloomJustification: "Apply",
      source: "seed",
      status: "active",
    })
    .run();
  return qid;
}

describe("applyMcqAttempt (E2 / AT21)", () => {
  let handle: ReturnType<typeof freshDb>;
  beforeEach(() => {
    handle = freshDb();
    seedDomainAndTs(handle.db);
  });

  it("inserts a row on first wrong answer with interval=1 and lastGrade=0", () => {
    const qid = seedQuestion(handle.db, "D1.1");
    const now = Date.UTC(2026, 3, 14, 12);
    const out = applyMcqAttempt(qid, false, { now }, handle.db);
    expect(out.intervalDays).toBe(1);
    expect(out.quality).toBe(0); // again
    expect(out.dueAt).toBe(now + DAY_MS);

    const row = handle.db
      .select()
      .from(schema.mcqReviewState)
      .where(eq(schema.mcqReviewState.questionId, qid))
      .get();
    expect(row?.reviewsCount).toBe(1);
    expect(row?.lastGrade).toBe(0);
    handle.close();
  });

  it("advances interval on success and resets on subsequent failure", () => {
    const qid = seedQuestion(handle.db, "D1.1");
    const t0 = Date.UTC(2026, 3, 14, 12);

    // First success — graduates interval to 1 day
    const r1 = applyMcqAttempt(qid, true, { now: t0 }, handle.db);
    expect(r1.intervalDays).toBe(1);
    expect(r1.quality).toBe(4);

    // Second success — second-graduation step → 6 days
    const r2 = applyMcqAttempt(qid, true, { now: t0 + DAY_MS }, handle.db);
    expect(r2.intervalDays).toBe(6);

    // Now fail — interval resets to 1, EF takes a hit
    const r3 = applyMcqAttempt(qid, false, { now: t0 + 2 * DAY_MS }, handle.db);
    expect(r3.intervalDays).toBe(1);
    expect(r3.quality).toBe(0);
    expect(r3.easeFactor).toBeLessThan(2.5);

    const row = handle.db
      .select()
      .from(schema.mcqReviewState)
      .where(eq(schema.mcqReviewState.questionId, qid))
      .get();
    expect(row?.reviewsCount).toBe(3);
    handle.close();
  });

  it("idempotent on same (questionId, ts) — last write wins on the row", () => {
    const qid = seedQuestion(handle.db, "D1.1");
    const t0 = Date.UTC(2026, 3, 14, 12);
    applyMcqAttempt(qid, false, { now: t0 }, handle.db);
    applyMcqAttempt(qid, false, { now: t0 }, handle.db);
    const row = handle.db
      .select()
      .from(schema.mcqReviewState)
      .where(eq(schema.mcqReviewState.questionId, qid))
      .get();
    // Two reviews logged, but only one row.
    expect(row?.reviewsCount).toBe(2);
    const rowsAll = handle.db.select().from(schema.mcqReviewState).all();
    expect(rowsAll).toHaveLength(1);
    handle.close();
  });
});

describe("listDueMcqs / countDueMcqs", () => {
  let handle: ReturnType<typeof freshDb>;
  beforeEach(() => {
    handle = freshDb();
    seedDomainAndTs(handle.db);
  });

  it("returns due items in due-soonest order, success items not yet due", () => {
    const t0 = Date.UTC(2026, 3, 14, 12);
    const q1 = seedQuestion(handle.db, "D1.1", "q1");
    const q2 = seedQuestion(handle.db, "D1.1", "q2");
    const q3 = seedQuestion(handle.db, "D1.1", "q3");
    applyMcqAttempt(q1, false, { now: t0 - 2 * DAY_MS }, handle.db); // due t0 - 1 DAY
    applyMcqAttempt(q2, false, { now: t0 - DAY_MS }, handle.db); // due t0
    // q3: two consecutive successes push the interval from 0 → 1 → 6, so the
    // final due_at lands t0 + 5 days — well outside the queue at t0.
    applyMcqAttempt(q3, true, { now: t0 - 3 * DAY_MS }, handle.db);
    applyMcqAttempt(q3, true, { now: t0 - 2 * DAY_MS }, handle.db);

    const due = listDueMcqs({ now: t0, db: handle.db });
    expect(due.map((d) => d.questionId)).toEqual(["q1", "q2"]);
    expect(countDueMcqs({ now: t0, db: handle.db })).toBe(2);
    handle.close();
  });

  it("retired questions drop out of the queue automatically", () => {
    const t0 = Date.UTC(2026, 3, 14, 12);
    const q1 = seedQuestion(handle.db, "D1.1", "q1");
    applyMcqAttempt(q1, false, { now: t0 - DAY_MS }, handle.db);
    expect(countDueMcqs({ now: t0, db: handle.db })).toBe(1);

    handle.db
      .update(schema.questions)
      .set({ status: "retired" })
      .where(eq(schema.questions.id, q1))
      .run();
    expect(countDueMcqs({ now: t0, db: handle.db })).toBe(0);
    handle.close();
  });
});

describe("writeProgressEvent integration with SRS", () => {
  let handle: ReturnType<typeof freshDb>;
  beforeEach(() => {
    handle = freshDb();
    seedDomainAndTs(handle.db);
  });

  it("seeds an mcq_review_state row on every mcq_answer event with question_id payload", () => {
    const qid = seedQuestion(handle.db, "D1.1");
    const t0 = new Date("2026-04-14T12:00:00Z");
    writeProgressEvent(
      {
        kind: "mcq_answer",
        taskStatementId: "D1.1",
        bloomLevel: 3,
        success: false,
        ts: t0,
        payload: { question_id: qid, selected: 1, correct_index: 0 },
      },
      handle.db,
    );
    const row = handle.db
      .select()
      .from(schema.mcqReviewState)
      .where(eq(schema.mcqReviewState.questionId, qid))
      .get();
    expect(row).toBeDefined();
    expect(row?.lastGrade).toBe(0);
    handle.close();
  });

  it("does not touch mcq_review_state for non-MCQ event kinds", () => {
    const qid = seedQuestion(handle.db, "D1.1");
    const t0 = new Date("2026-04-14T12:00:00Z");
    writeProgressEvent(
      {
        kind: "tutor_signal",
        taskStatementId: "D1.1",
        bloomLevel: 3,
        success: true,
        ts: t0,
        payload: { question_id: qid }, // even with the id present
      },
      handle.db,
    );
    const row = handle.db
      .select()
      .from(schema.mcqReviewState)
      .where(eq(schema.mcqReviewState.questionId, qid))
      .get();
    expect(row).toBeUndefined();
    handle.close();
  });

  it("silently skips when mcq_answer has no question_id in payload", () => {
    const t0 = new Date("2026-04-14T12:00:00Z");
    expect(() =>
      writeProgressEvent(
        {
          kind: "mcq_answer",
          taskStatementId: "D1.1",
          bloomLevel: 3,
          success: false,
          ts: t0,
          payload: {},
        },
        handle.db,
      ),
    ).not.toThrow();
    const rows = handle.db.select().from(schema.mcqReviewState).all();
    expect(rows).toHaveLength(0);
    handle.close();
  });
});

describe("buildDrillPool · scope=due-mcq", () => {
  let handle: ReturnType<typeof freshDb>;
  beforeEach(() => {
    handle = freshDb();
    seedDomainAndTs(handle.db);
  });

  it("returns only items currently due, ordered by due_at asc", () => {
    const t0 = Date.UTC(2026, 3, 14, 12);
    const q1 = seedQuestion(handle.db, "D1.1", "q1");
    const q2 = seedQuestion(handle.db, "D1.1", "q2");
    const q3 = seedQuestion(handle.db, "D1.1", "q3");
    applyMcqAttempt(q1, false, { now: t0 - 2 * DAY_MS }, handle.db); // due t0 - DAY
    applyMcqAttempt(q2, false, { now: t0 - DAY_MS }, handle.db); // due t0
    // q3: two successes push interval to 6 → due_at = t0 + 4 days
    applyMcqAttempt(q3, true, { now: t0 - 3 * DAY_MS }, handle.db);
    applyMcqAttempt(q3, true, { now: t0 - 2 * DAY_MS }, handle.db);

    const pool = buildDrillPool(
      { type: "due-mcq" },
      { db: handle.db, now: t0, limit: 10 },
    );
    expect(pool.questions.map((q) => q.id)).toEqual(["q1", "q2"]);
    expect(pool.availableCount).toBe(2);
    handle.close();
  });

  it("respects the limit and the bloom filter", () => {
    const t0 = Date.UTC(2026, 3, 14, 12);
    const q1 = seedQuestion(handle.db, "D1.1", "q1");
    const q2 = seedQuestion(handle.db, "D1.1", "q2");
    handle.db
      .update(schema.questions)
      .set({ bloomLevel: 4 })
      .where(eq(schema.questions.id, q2))
      .run();
    applyMcqAttempt(q1, false, { now: t0 - DAY_MS }, handle.db);
    applyMcqAttempt(q2, false, { now: t0 - DAY_MS }, handle.db);

    const onlyL3 = buildDrillPool(
      { type: "due-mcq" },
      { db: handle.db, now: t0, bloomLevel: 3 },
    );
    expect(onlyL3.questions.map((q) => q.id)).toEqual(["q1"]);

    const limited = buildDrillPool(
      { type: "due-mcq" },
      { db: handle.db, now: t0, limit: 1 },
    );
    expect(limited.questions).toHaveLength(1);
    expect(limited.availableCount).toBe(2);
    handle.close();
  });
});
