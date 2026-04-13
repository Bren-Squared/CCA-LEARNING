import Database from "better-sqlite3";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../lib/db";
import { schema } from "../lib/db";
import { writeProgressEvent } from "../lib/progress/events";

const DRIZZLE_DIR = resolve(process.cwd(), "drizzle");
const DAY_MS = 1000 * 60 * 60 * 24;

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

function seedCurriculum(db: Db): void {
  db.insert(schema.domains)
    .values({ id: "D1", title: "Domain 1", weightBps: 5000, orderIndex: 1 })
    .run();
  db.insert(schema.taskStatements)
    .values({
      id: "TS1",
      domainId: "D1",
      title: "Task 1",
      knowledgeBullets: [],
      skillsBullets: [],
      orderIndex: 1,
    })
    .run();
  db.insert(schema.taskStatements)
    .values({
      id: "TS2",
      domainId: "D1",
      title: "Task 2",
      knowledgeBullets: [],
      skillsBullets: [],
      orderIndex: 2,
    })
    .run();
}

describe("writeProgressEvent", () => {
  let handle: ReturnType<typeof freshDb>;

  beforeEach(() => {
    handle = freshDb();
    seedCurriculum(handle.db);
  });

  it("appends an event AND upserts a fresh mastery snapshot", () => {
    const result = writeProgressEvent(
      {
        kind: "mcq_answer",
        taskStatementId: "TS1",
        bloomLevel: 2,
        success: true,
        payload: { question_id: "q1" },
      },
      handle.db,
    );

    expect(result.eventId).toBeDefined();
    expect(result.itemCount).toBe(1);
    expect(result.score).toBeCloseTo(100, 5);

    const events = handle.db
      .select()
      .from(schema.progressEvents)
      .all();
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("mcq_answer");
    expect(events[0].bloomLevel).toBe(2);
    expect(events[0].success).toBe(true);

    const snap = handle.db
      .select()
      .from(schema.masterySnapshots)
      .where(
        and(
          eq(schema.masterySnapshots.taskStatementId, "TS1"),
          eq(schema.masterySnapshots.bloomLevel, 2),
        ),
      )
      .get();
    expect(snap).toBeDefined();
    expect(snap!.score).toBeCloseTo(100, 5);
    expect(snap!.itemCount).toBe(1);
    handle.close();
  });

  it("acceptance FR4: 10 correct Understand events → score > 80, itemCount = 10", () => {
    for (let i = 0; i < 10; i++) {
      writeProgressEvent(
        {
          kind: "mcq_answer",
          taskStatementId: "TS1",
          bloomLevel: 2,
          success: true,
          ts: new Date(Date.now() - i * 1000), // close-in-time
        },
        handle.db,
      );
    }

    const snap = handle.db
      .select()
      .from(schema.masterySnapshots)
      .where(
        and(
          eq(schema.masterySnapshots.taskStatementId, "TS1"),
          eq(schema.masterySnapshots.bloomLevel, 2),
        ),
      )
      .get();
    expect(snap).toBeDefined();
    expect(snap!.score).toBeGreaterThan(80);
    expect(snap!.itemCount).toBe(10);
    handle.close();
  });

  it("keeps bloom levels isolated — writing to level 2 doesn't touch level 3", () => {
    writeProgressEvent(
      {
        kind: "mcq_answer",
        taskStatementId: "TS1",
        bloomLevel: 2,
        success: true,
      },
      handle.db,
    );
    writeProgressEvent(
      {
        kind: "mcq_answer",
        taskStatementId: "TS1",
        bloomLevel: 3,
        success: false,
      },
      handle.db,
    );

    const snaps = handle.db
      .select()
      .from(schema.masterySnapshots)
      .where(eq(schema.masterySnapshots.taskStatementId, "TS1"))
      .all();
    expect(snaps).toHaveLength(2);
    const l2 = snaps.find((s) => s.bloomLevel === 2)!;
    const l3 = snaps.find((s) => s.bloomLevel === 3)!;
    expect(l2.score).toBeCloseTo(100, 5);
    expect(l2.itemCount).toBe(1);
    expect(l3.score).toBe(0);
    expect(l3.itemCount).toBe(1);
    handle.close();
  });

  it("keeps task statements isolated — writing to TS1 doesn't touch TS2", () => {
    writeProgressEvent(
      { kind: "mcq_answer", taskStatementId: "TS1", bloomLevel: 2, success: true },
      handle.db,
    );

    const ts2Snaps = handle.db
      .select()
      .from(schema.masterySnapshots)
      .where(eq(schema.masterySnapshots.taskStatementId, "TS2"))
      .all();
    expect(ts2Snaps).toHaveLength(0);
    handle.close();
  });

  it("applies decay — old failures lose weight vs recent successes", () => {
    // One old failure (90 days), one recent success (today) at same level
    writeProgressEvent(
      {
        kind: "mcq_answer",
        taskStatementId: "TS1",
        bloomLevel: 2,
        success: false,
        ts: new Date(Date.now() - 90 * DAY_MS),
      },
      handle.db,
    );
    writeProgressEvent(
      {
        kind: "mcq_answer",
        taskStatementId: "TS1",
        bloomLevel: 2,
        success: true,
        ts: new Date(),
      },
      handle.db,
    );

    const snap = handle.db
      .select()
      .from(schema.masterySnapshots)
      .where(
        and(
          eq(schema.masterySnapshots.taskStatementId, "TS1"),
          eq(schema.masterySnapshots.bloomLevel, 2),
        ),
      )
      .get();
    expect(snap).toBeDefined();
    // 90 days ≈ 6.4 half-lives → weight ~0.012. Recent win dominates.
    // Raw avg would be 50; decay-weighted should be > 95.
    expect(snap!.score).toBeGreaterThan(95);
    expect(snap!.itemCount).toBe(2);
    handle.close();
  });

  it("upserts — repeated events at the same (ts, level) update the same row", () => {
    for (let i = 0; i < 3; i++) {
      writeProgressEvent(
        { kind: "mcq_answer", taskStatementId: "TS1", bloomLevel: 2, success: true },
        handle.db,
      );
    }
    const rows = handle.db
      .select()
      .from(schema.masterySnapshots)
      .where(
        and(
          eq(schema.masterySnapshots.taskStatementId, "TS1"),
          eq(schema.masterySnapshots.bloomLevel, 2),
        ),
      )
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0].itemCount).toBe(3);
    handle.close();
  });
});
