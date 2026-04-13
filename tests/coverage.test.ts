import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../lib/db";
import { schema } from "../lib/db";
import {
  buildCoverageReport,
  COVERAGE_BLOOM_LEVELS,
  COVERAGE_TARGET,
  flagQuestion,
  selectFillTargets,
} from "../lib/study/coverage";

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
      { id: "D1", title: "Domain 1", weightBps: 5000, orderIndex: 1 },
      { id: "D2", title: "Domain 2", weightBps: 5000, orderIndex: 2 },
    ])
    .run();
  db.insert(schema.taskStatements)
    .values([
      {
        id: "TS1",
        domainId: "D1",
        title: "Task 1",
        knowledgeBullets: [],
        skillsBullets: [],
        orderIndex: 1,
      },
      {
        id: "TS2",
        domainId: "D2",
        title: "Task 2",
        knowledgeBullets: [],
        skillsBullets: [],
        orderIndex: 2,
      },
    ])
    .run();
}

let qCounter = 0;
function seedQuestion(
  db: Db,
  opts: {
    taskStatementId: string;
    bloomLevel: number;
    status?: "active" | "flagged" | "retired";
  },
): string {
  const id = `Q${++qCounter}`;
  db.insert(schema.questions)
    .values({
      id,
      taskStatementId: opts.taskStatementId,
      stem: `stem-${id}`,
      options: ["a", "b", "c", "d"],
      correctIndex: 0,
      explanations: ["", "", "", ""],
      difficulty: 2,
      bloomLevel: opts.bloomLevel,
      bloomJustification: "test",
      source: "seed",
      status: opts.status ?? "active",
    })
    .run();
  return id;
}

describe("buildCoverageReport", () => {
  let handle: ReturnType<typeof freshDb>;
  beforeEach(() => {
    qCounter = 0;
    handle = freshDb();
    seedCurriculum(handle.db);
  });

  it("reports all cells as full gaps when the bank is empty", () => {
    const report = buildCoverageReport(handle.db);
    // 2 task statements × 5 tracked bloom levels = 10 cells
    expect(report.cells).toHaveLength(10);
    expect(report.totals.totalCells).toBe(10);
    expect(report.totals.gapCells).toBe(10);
    expect(report.totals.gapQuestions).toBe(10 * COVERAGE_TARGET);
    expect(report.totals.fullCells).toBe(0);
    expect(report.totals.activeQuestions).toBe(0);
    handle.close();
  });

  it("only tracks bloom levels 1 through 5", () => {
    const report = buildCoverageReport(handle.db);
    const levels = new Set(report.cells.map((c) => c.bloomLevel));
    expect(Array.from(levels).sort()).toEqual([...COVERAGE_BLOOM_LEVELS]);
    handle.close();
  });

  it("counts only active questions (not retired/flagged)", () => {
    seedQuestion(handle.db, { taskStatementId: "TS1", bloomLevel: 2 });
    seedQuestion(handle.db, {
      taskStatementId: "TS1",
      bloomLevel: 2,
      status: "retired",
    });
    seedQuestion(handle.db, {
      taskStatementId: "TS1",
      bloomLevel: 2,
      status: "flagged",
    });
    const cell = buildCoverageReport(handle.db).cells.find(
      (c) => c.taskStatementId === "TS1" && c.bloomLevel === 2,
    );
    expect(cell?.activeCount).toBe(1);
    expect(cell?.gap).toBe(COVERAGE_TARGET - 1);
    handle.close();
  });

  it("marks a cell as filled when count reaches target", () => {
    for (let i = 0; i < COVERAGE_TARGET; i++) {
      seedQuestion(handle.db, { taskStatementId: "TS1", bloomLevel: 3 });
    }
    const report = buildCoverageReport(handle.db);
    const cell = report.cells.find(
      (c) => c.taskStatementId === "TS1" && c.bloomLevel === 3,
    );
    expect(cell?.activeCount).toBe(COVERAGE_TARGET);
    expect(cell?.gap).toBe(0);
    expect(report.gaps.find((g) => g === cell)).toBeUndefined();
    handle.close();
  });

  it("reports gap totals correctly with mixed state", () => {
    // TS1 L1: 3/5, TS2 L5: 5/5 full, everything else: 0/5
    seedQuestion(handle.db, { taskStatementId: "TS1", bloomLevel: 1 });
    seedQuestion(handle.db, { taskStatementId: "TS1", bloomLevel: 1 });
    seedQuestion(handle.db, { taskStatementId: "TS1", bloomLevel: 1 });
    for (let i = 0; i < COVERAGE_TARGET; i++) {
      seedQuestion(handle.db, { taskStatementId: "TS2", bloomLevel: 5 });
    }
    const report = buildCoverageReport(handle.db);
    expect(report.totals.activeQuestions).toBe(3 + COVERAGE_TARGET);
    expect(report.totals.fullCells).toBe(1);
    // 10 total cells − 1 full = 9 gap cells
    expect(report.totals.gapCells).toBe(9);
    // TS1/L1 gap = 2; 8 other empty cells × 5 each = 40; total gap = 42
    expect(report.totals.gapQuestions).toBe(2 + 8 * COVERAGE_TARGET);
    handle.close();
  });
});

describe("selectFillTargets", () => {
  let handle: ReturnType<typeof freshDb>;
  beforeEach(() => {
    qCounter = 0;
    handle = freshDb();
    seedCurriculum(handle.db);
  });

  it("returns empty when n is zero", () => {
    const report = buildCoverageReport(handle.db);
    expect(selectFillTargets(report, 0)).toEqual([]);
    handle.close();
  });

  it("prioritizes cells with the largest gap first", () => {
    // TS1/L1 already has 4 — gap=1; TS1/L2 empty — gap=5
    for (let i = 0; i < 4; i++) {
      seedQuestion(handle.db, { taskStatementId: "TS1", bloomLevel: 1 });
    }
    const report = buildCoverageReport(handle.db);
    const first = selectFillTargets(report, 1);
    expect(first[0]).not.toEqual({ taskStatementId: "TS1", bloomLevel: 1 });
    handle.close();
  });

  it("caps at n and does not exceed total gap size", () => {
    const report = buildCoverageReport(handle.db);
    const targets = selectFillTargets(report, 100_000);
    expect(targets.length).toBe(report.totals.gapQuestions);
    handle.close();
  });

  it("only returns targets for cells that still have gaps", () => {
    for (let i = 0; i < COVERAGE_TARGET; i++) {
      seedQuestion(handle.db, { taskStatementId: "TS1", bloomLevel: 3 });
    }
    const report = buildCoverageReport(handle.db);
    const targets = selectFillTargets(report, 50);
    expect(
      targets.find(
        (t) => t.taskStatementId === "TS1" && t.bloomLevel === 3,
      ),
    ).toBeUndefined();
    handle.close();
  });
});

describe("flagQuestion", () => {
  let handle: ReturnType<typeof freshDb>;
  beforeEach(() => {
    qCounter = 0;
    handle = freshDb();
    seedCurriculum(handle.db);
  });

  it("retires an active question", () => {
    const id = seedQuestion(handle.db, {
      taskStatementId: "TS1",
      bloomLevel: 2,
    });
    const result = flagQuestion(id, handle.db);
    expect(result).toEqual({ ok: true, previousStatus: "active" });
    const row = handle.db
      .select()
      .from(schema.questions)
      .where(eq(schema.questions.id, id))
      .get();
    expect(row?.status).toBe("retired");
    handle.close();
  });

  it("is idempotent on already-retired questions", () => {
    const id = seedQuestion(handle.db, {
      taskStatementId: "TS1",
      bloomLevel: 2,
      status: "retired",
    });
    const result = flagQuestion(id, handle.db);
    expect(result).toEqual({ ok: true, previousStatus: "retired" });
    handle.close();
  });

  it("returns not_found for a missing id", () => {
    const result = flagQuestion("bogus-id", handle.db);
    expect(result).toEqual({ ok: false, reason: "not_found" });
    handle.close();
  });
});
