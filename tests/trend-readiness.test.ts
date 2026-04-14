import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../lib/db";
import { schema } from "../lib/db";
import { computeReadiness } from "../lib/progress/mastery";
import { writeProgressEvent } from "../lib/progress/events";
import { buildTrendSeries } from "../lib/progress/trend";

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

function seedCurriculum(db: Db): void {
  db.insert(schema.domains)
    .values([
      { id: "D1", title: "Heavy domain", weightBps: 4000, orderIndex: 1 },
      { id: "D2", title: "Light domain", weightBps: 1000, orderIndex: 2 },
    ])
    .run();
  db.insert(schema.taskStatements)
    .values([
      {
        id: "D1.1",
        domainId: "D1",
        title: "TS D1.1",
        knowledgeBullets: [],
        skillsBullets: [],
        orderIndex: 1,
      },
      {
        id: "D2.1",
        domainId: "D2",
        title: "TS D2.1",
        knowledgeBullets: [],
        skillsBullets: [],
        orderIndex: 2,
      },
    ])
    .run();
}

describe("computeReadiness", () => {
  it("returns 0 for empty input", () => {
    expect(computeReadiness([])).toBe(0);
  });

  it("returns 0 when total weight is 0 (defensive)", () => {
    expect(
      computeReadiness([
        { summary: 50, weightBps: 0 },
        { summary: 90, weightBps: 0 },
      ]),
    ).toBe(0);
  });

  it("computes a correct weighted mean", () => {
    // 80 × 4000 + 20 × 1000 = 340000 / 5000 = 68
    expect(
      computeReadiness([
        { summary: 80, weightBps: 4000 },
        { summary: 20, weightBps: 1000 },
      ]),
    ).toBeCloseTo(68, 6);
  });

  it("heavy-domain dominance: a high heavy-domain score outranks a low light-domain score", () => {
    const heavyFirst = computeReadiness([
      { summary: 90, weightBps: 4000 },
      { summary: 10, weightBps: 1000 },
    ]);
    const lightFirst = computeReadiness([
      { summary: 10, weightBps: 4000 },
      { summary: 90, weightBps: 1000 },
    ]);
    expect(heavyFirst).toBeGreaterThan(lightFirst);
  });
});

describe("buildTrendSeries", () => {
  let handle: ReturnType<typeof freshDb>;
  beforeEach(() => {
    handle = freshDb();
    seedCurriculum(handle.db);
  });

  it("returns `days` points with zeroed summaries when no events exist", () => {
    const s = buildTrendSeries(handle.db, { days: 7 });
    expect(s.days).toBe(7);
    expect(s.points).toHaveLength(7);
    for (const p of s.points) {
      expect(p.domains.D1).toBe(0);
      expect(p.domains.D2).toBe(0);
      expect(p.readiness).toBe(0);
    }
    expect(s.domains.map((d) => d.id)).toEqual(["D1", "D2"]);
    handle.close();
  });

  it("points are ordered oldest → newest", () => {
    const now = new Date("2026-04-15T12:00:00Z");
    const s = buildTrendSeries(handle.db, { days: 5, now });
    const timestamps = s.points.map((p) => p.timestamp);
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i]).toBeGreaterThan(timestamps[i - 1]);
    }
    handle.close();
  });

  it("event written today shows up on today's point; older days remain at 0", () => {
    const now = new Date();
    writeProgressEvent(
      {
        kind: "mcq_answer",
        taskStatementId: "D1.1",
        bloomLevel: 1,
        success: true,
        ts: now,
      },
      handle.db,
    );
    const s = buildTrendSeries(handle.db, { days: 3, now });
    expect(s.points[0].domains.D1).toBe(0);
    expect(s.points[1].domains.D1).toBe(0);
    expect(s.points[2].domains.D1).toBeGreaterThan(0);
    expect(s.points[2].readiness).toBeGreaterThan(0);
    handle.close();
  });

  it("as events accumulate day-over-day the domain series is non-decreasing", () => {
    const now = new Date();
    // Write one correct L1 event on each of days -4, -3, -2, -1, 0
    for (let back = 4; back >= 0; back--) {
      writeProgressEvent(
        {
          kind: "mcq_answer",
          taskStatementId: "D1.1",
          bloomLevel: 1,
          success: true,
          ts: new Date(now.getTime() - back * DAY_MS),
        },
        handle.db,
      );
    }
    const s = buildTrendSeries(handle.db, {
      days: 5,
      now,
      halfLifeDays: 365, // neutralize decay so accumulation math is clean
    });
    const d1 = s.points.map((p) => p.domains.D1);
    // Each subsequent day adds weight to the weighted score; under infinite
    // half-life and all-success, the score stays ~100 once events exist.
    expect(d1[0]).toBeGreaterThan(0);
    for (let i = 1; i < d1.length; i++) {
      expect(d1[i]).toBeGreaterThanOrEqual(d1[i - 1] - 0.001);
    }
    handle.close();
  });

  it("events outside the window still count toward today's score (replay is cumulative)", () => {
    const now = new Date();
    // Write 10 old correct events (60 days back) — outside a 30-day window
    for (let i = 0; i < 10; i++) {
      writeProgressEvent(
        {
          kind: "mcq_answer",
          taskStatementId: "D1.1",
          bloomLevel: 1,
          success: true,
          ts: new Date(now.getTime() - 60 * DAY_MS - i * 1000),
        },
        handle.db,
      );
    }
    const s = buildTrendSeries(handle.db, {
      days: 30,
      now,
      halfLifeDays: 365,
    });
    // All 30 points should see those old events
    for (const p of s.points) {
      expect(p.domains.D1).toBeGreaterThan(0);
    }
    handle.close();
  });

  it("cross-domain isolation: D1 events don't move D2's line", () => {
    const now = new Date();
    writeProgressEvent(
      {
        kind: "mcq_answer",
        taskStatementId: "D1.1",
        bloomLevel: 1,
        success: true,
        ts: now,
      },
      handle.db,
    );
    const s = buildTrendSeries(handle.db, { days: 3, now });
    expect(s.points[2].domains.D2).toBe(0);
    expect(s.points[2].domains.D1).toBeGreaterThan(0);
    handle.close();
  });

  it("readiness is weighted by domain_weight_bps", () => {
    const now = new Date();
    // Master D2.1 at L1. D1.1 stays empty.
    for (let i = 0; i < 10; i++) {
      writeProgressEvent(
        {
          kind: "mcq_answer",
          taskStatementId: "D2.1",
          bloomLevel: 1,
          success: true,
          ts: new Date(now.getTime() - i * 1000),
        },
        handle.db,
      );
    }
    const s = buildTrendSeries(handle.db, { days: 2, now });
    const latest = s.points[s.points.length - 1];
    expect(latest.domains.D2).toBeGreaterThan(0);
    expect(latest.domains.D1).toBe(0);
    // Expected readiness = (0 × 4000 + D2 × 1000) / 5000 = D2 / 5
    expect(latest.readiness).toBeCloseTo(latest.domains.D2 / 5, 5);
    handle.close();
  });
});
