import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../lib/db";
import { schema } from "../lib/db";
import {
  buildDashboard,
  buildTaskStatementRollup,
  WEAK_AREA_LIMIT,
} from "../lib/progress/dashboard";
import {
  type BloomLevel,
  BLOOM_LEVELS,
  ceilingLevel,
  isMastered,
  type LevelScore,
  nextLevel,
} from "../lib/progress/mastery";
import { writeProgressEvent } from "../lib/progress/events";

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
        id: "D1.2",
        domainId: "D1",
        title: "TS D1.2",
        knowledgeBullets: [],
        skillsBullets: [],
        orderIndex: 2,
      },
      {
        id: "D2.1",
        domainId: "D2",
        title: "TS D2.1",
        knowledgeBullets: [],
        skillsBullets: [],
        orderIndex: 3,
      },
    ])
    .run();
}

describe("ceilingLevel / nextLevel", () => {
  function mastered(n: number): LevelScore {
    return { score: 1.0, itemCount: n };
  }
  function partial(score: number, n: number): LevelScore {
    return { score, itemCount: n };
  }

  it("returns 0 when no levels are mastered", () => {
    const perLevel: Partial<Record<BloomLevel, LevelScore>> = {
      1: partial(0.9, 3), // fails item floor
      2: partial(0.7, 10), // fails score threshold
    };
    expect(ceilingLevel(perLevel)).toBe(0);
    expect(nextLevel(perLevel)).toBe(1);
  });

  it("returns the highest mastered level when multiple are mastered", () => {
    const perLevel: Partial<Record<BloomLevel, LevelScore>> = {
      1: mastered(10),
      2: mastered(8),
      3: mastered(6),
      4: partial(0.5, 5),
    };
    expect(ceilingLevel(perLevel)).toBe(3);
    expect(nextLevel(perLevel)).toBe(4);
  });

  it("handles non-contiguous masteries — returns the max, not the first", () => {
    const perLevel: Partial<Record<BloomLevel, LevelScore>> = {
      1: mastered(10),
      3: mastered(6),
    };
    expect(ceilingLevel(perLevel)).toBe(3);
    expect(nextLevel(perLevel)).toBe(4);
  });

  it("caps next level at 6", () => {
    const perLevel: Partial<Record<BloomLevel, LevelScore>> = {};
    for (const lvl of BLOOM_LEVELS) perLevel[lvl] = mastered(10);
    expect(ceilingLevel(perLevel)).toBe(6);
    expect(nextLevel(perLevel)).toBe(6);
  });

  it("confirms threshold invariants match isMastered", () => {
    expect(isMastered({ score: 0.8, itemCount: 5 })).toBe(true);
    expect(isMastered({ score: 0.79, itemCount: 5 })).toBe(false);
    expect(isMastered({ score: 0.8, itemCount: 4 })).toBe(false);
  });
});

describe("buildDashboard", () => {
  let handle: ReturnType<typeof freshDb>;

  beforeEach(() => {
    handle = freshDb();
    seedCurriculum(handle.db);
  });

  it("returns empty-safe payload when no events exist", () => {
    const d = buildDashboard(handle.db);
    expect(d.domains).toHaveLength(2);
    expect(d.totals.activeTaskStatements).toBe(3);
    expect(d.totals.masteredCells).toBe(0);
    expect(d.totals.totalCells).toBe(3 * 6);
    expect(d.totals.overallSummary).toBe(0);
    expect(d.lastSession.totalEvents).toBe(0);
    expect(d.weakAreas.length).toBeLessThanOrEqual(WEAK_AREA_LIMIT);
    for (const ts of d.domains.flatMap((x) => x.taskStatements)) {
      expect(ts.ceiling).toBe(0);
      expect(ts.nextLevel).toBe(1);
      expect(ts.summary).toBe(0);
    }
    handle.close();
  });

  it("rolls per-level snapshots into a TS summary and sets ceiling", () => {
    for (let i = 0; i < 10; i++) {
      writeProgressEvent(
        { kind: "mcq_answer", taskStatementId: "D1.1", bloomLevel: 1, success: true },
        handle.db,
      );
      writeProgressEvent(
        { kind: "mcq_answer", taskStatementId: "D1.1", bloomLevel: 2, success: true },
        handle.db,
      );
    }

    const d = buildDashboard(handle.db);
    const d1 = d.domains.find((x) => x.domainId === "D1")!;
    const ts = d1.taskStatements.find((x) => x.taskStatementId === "D1.1")!;

    expect(ts.ceiling).toBe(2);
    expect(ts.nextLevel).toBe(3);
    expect(ts.levels.find((l) => l.level === 1)!.mastered).toBe(true);
    expect(ts.levels.find((l) => l.level === 2)!.mastered).toBe(true);
    expect(ts.levels.find((l) => l.level === 3)!.mastered).toBe(false);

    // TS summary = (1*1 + 2*1 + 4*0 + ...) / 63 * 100 = 300/63 ≈ 4.76
    expect(ts.summary).toBeCloseTo((3 / 63) * 100, 2);
    handle.close();
  });

  it("ranks weak areas by (gap × domain weight); heavy-domain gap beats light-domain gap", () => {
    // Master everything on D2.1 (the light domain), leave D1 empty.
    for (let i = 0; i < 5; i++) {
      for (const lvl of [1, 2, 3, 4, 5, 6] as const) {
        writeProgressEvent(
          { kind: "mcq_answer", taskStatementId: "D2.1", bloomLevel: lvl, success: true },
          handle.db,
        );
      }
    }

    const d = buildDashboard(handle.db);
    // Top weak areas should be D1.* — both have gap=100, weight=40 → priority 40.
    // D2.1 has gap≈0 → priority ≈ 0.
    const top = d.weakAreas.map((w) => w.taskStatementId);
    expect(top.slice(0, 2).sort()).toEqual(["D1.1", "D1.2"]);
    const d1Prio = d.weakAreas.find((w) => w.taskStatementId === "D1.1")!.priority;
    const d2Prio = d.weakAreas.find((w) => w.taskStatementId === "D2.1")?.priority ?? 0;
    expect(d1Prio).toBeGreaterThan(d2Prio);
    expect(d1Prio).toBeCloseTo(100 * 0.4, 5);
    handle.close();
  });

  it("annotates weak areas with current ceiling", () => {
    for (let i = 0; i < 10; i++) {
      writeProgressEvent(
        { kind: "mcq_answer", taskStatementId: "D1.1", bloomLevel: 1, success: true },
        handle.db,
      );
    }
    const d = buildDashboard(handle.db);
    const w = d.weakAreas.find((x) => x.taskStatementId === "D1.1")!;
    expect(w.ceiling).toBe(1);
  });

  it("computes last-session recap from most recent progress events", () => {
    const earlier = new Date(Date.now() - 60_000);
    const later = new Date();
    writeProgressEvent(
      {
        kind: "mcq_answer",
        taskStatementId: "D1.1",
        bloomLevel: 2,
        success: true,
        ts: earlier,
      },
      handle.db,
    );
    writeProgressEvent(
      {
        kind: "mcq_answer",
        taskStatementId: "D1.2",
        bloomLevel: 3,
        success: false,
        ts: later,
      },
      handle.db,
    );

    const d = buildDashboard(handle.db);
    expect(d.lastSession.totalEvents).toBe(2);
    expect(d.lastSession.successCount).toBe(1);
    expect(d.lastSession.uniqueCells).toBe(2);
    expect(d.lastSession.events[0].success).toBe(false); // most recent first
    handle.close();
  });

  it("buildTaskStatementRollup returns null for unknown id", () => {
    expect(buildTaskStatementRollup("NOPE", handle.db)).toBeNull();
    handle.close();
  });

  it("buildTaskStatementRollup computes per-level cells and next level", () => {
    for (let i = 0; i < 10; i++) {
      writeProgressEvent(
        { kind: "mcq_answer", taskStatementId: "D1.1", bloomLevel: 1, success: true },
        handle.db,
      );
    }
    const r = buildTaskStatementRollup("D1.1", handle.db)!;
    expect(r.taskStatementId).toBe("D1.1");
    expect(r.ceiling).toBe(1);
    expect(r.nextLevel).toBe(2);
    expect(r.levels).toHaveLength(6);
    expect(r.levels.find((l) => l.level === 1)!.mastered).toBe(true);
    expect(r.levels.find((l) => l.level === 2)!.mastered).toBe(false);
    expect(r.totalItems).toBe(10);
    handle.close();
  });

  it("overall summary is the mean of domain summaries", () => {
    // Fill D1.1 to a known level; D1.2 and D2.1 stay at 0.
    for (let i = 0; i < 10; i++) {
      writeProgressEvent(
        { kind: "mcq_answer", taskStatementId: "D1.1", bloomLevel: 1, success: true },
        handle.db,
      );
    }
    const d = buildDashboard(handle.db);
    // D1.1 summary = (1 * 1) / 63 * 100 = 100/63 ≈ 1.587
    // D1 summary = mean(D1.1, D1.2) = (1.587 + 0) / 2 ≈ 0.794
    // D2 summary = 0
    // overall = (0.794 + 0) / 2 ≈ 0.397
    const d1 = d.domains.find((x) => x.domainId === "D1")!;
    expect(d1.summary).toBeCloseTo(((100 / 63) + 0) / 2, 3);
    expect(d.totals.overallSummary).toBeCloseTo(
      (d1.summary + 0) / 2,
      5,
    );
    handle.close();
  });
});
