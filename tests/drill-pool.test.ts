import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../lib/db";
import { schema } from "../lib/db";
import {
  buildDrillPool,
  countQuestionsByScope,
  DEFAULT_DRILL_LIMIT,
} from "../lib/study/drill";

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

interface SeedOpts {
  id: string;
  taskStatementId: string;
  scenarioId?: string | null;
  status?: "active" | "retired";
  bloomLevel?: number;
}

function seedQuestion(db: Db, opts: SeedOpts): void {
  db.insert(schema.questions)
    .values({
      id: opts.id,
      taskStatementId: opts.taskStatementId,
      scenarioId: opts.scenarioId ?? null,
      stem: `stem-${opts.id}`,
      options: ["A", "B", "C", "D"],
      correctIndex: 0,
      explanations: ["", "", "", ""],
      difficulty: 2,
      bloomLevel: opts.bloomLevel ?? 2,
      bloomJustification: "test",
      source: "seed",
      status: opts.status ?? "active",
    })
    .run();
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
        domainId: "D1",
        title: "Task 2",
        knowledgeBullets: [],
        skillsBullets: [],
        orderIndex: 2,
      },
      {
        id: "TS3",
        domainId: "D2",
        title: "Task 3",
        knowledgeBullets: [],
        skillsBullets: [],
        orderIndex: 3,
      },
    ])
    .run();
  db.insert(schema.scenarios)
    .values({
      id: "SC1",
      title: "Scenario 1",
      description: "desc",
      orderIndex: 1,
    })
    .run();
}

describe("buildDrillPool", () => {
  let handle: ReturnType<typeof freshDb>;
  beforeEach(() => {
    handle = freshDb();
    seedCurriculum(handle.db);
  });

  it("returns empty pool when no active questions exist", () => {
    const pool = buildDrillPool({ type: "all" }, { db: handle.db });
    expect(pool.questions).toEqual([]);
    expect(pool.availableCount).toBe(0);
    handle.close();
  });

  it("scope=all includes every active question across task statements", () => {
    seedQuestion(handle.db, { id: "Q1", taskStatementId: "TS1" });
    seedQuestion(handle.db, { id: "Q2", taskStatementId: "TS2" });
    seedQuestion(handle.db, { id: "Q3", taskStatementId: "TS3" });
    const pool = buildDrillPool({ type: "all" }, { db: handle.db, seed: 1 });
    expect(pool.availableCount).toBe(3);
    expect(pool.questions.map((q) => q.id).sort()).toEqual(["Q1", "Q2", "Q3"]);
    handle.close();
  });

  it("excludes retired questions", () => {
    seedQuestion(handle.db, { id: "Q1", taskStatementId: "TS1" });
    seedQuestion(handle.db, {
      id: "Q2",
      taskStatementId: "TS1",
      status: "retired",
    });
    const pool = buildDrillPool({ type: "all" }, { db: handle.db });
    expect(pool.availableCount).toBe(1);
    expect(pool.questions[0].id).toBe("Q1");
    handle.close();
  });

  it("scope=domain filters by the domain's task statements", () => {
    seedQuestion(handle.db, { id: "QA", taskStatementId: "TS1" }); // D1
    seedQuestion(handle.db, { id: "QB", taskStatementId: "TS2" }); // D1
    seedQuestion(handle.db, { id: "QC", taskStatementId: "TS3" }); // D2
    const pool = buildDrillPool(
      { type: "domain", id: "D1" },
      { db: handle.db },
    );
    expect(pool.questions.map((q) => q.id).sort()).toEqual(["QA", "QB"]);
    expect(pool.availableCount).toBe(2);
    handle.close();
  });

  it("scope=task filters to a single task statement", () => {
    seedQuestion(handle.db, { id: "QA", taskStatementId: "TS1" });
    seedQuestion(handle.db, { id: "QB", taskStatementId: "TS2" });
    const pool = buildDrillPool({ type: "task", id: "TS1" }, { db: handle.db });
    expect(pool.questions.map((q) => q.id)).toEqual(["QA"]);
    handle.close();
  });

  it("scope=scenario filters by questions.scenarioId", () => {
    seedQuestion(handle.db, {
      id: "QA",
      taskStatementId: "TS1",
      scenarioId: "SC1",
    });
    seedQuestion(handle.db, {
      id: "QB",
      taskStatementId: "TS1",
      scenarioId: null,
    });
    const pool = buildDrillPool(
      { type: "scenario", id: "SC1" },
      { db: handle.db },
    );
    expect(pool.questions.map((q) => q.id)).toEqual(["QA"]);
    handle.close();
  });

  it("caps at limit and reports availableCount untruncated", () => {
    for (let i = 0; i < 15; i++) {
      seedQuestion(handle.db, {
        id: `Q${String(i).padStart(2, "0")}`,
        taskStatementId: "TS1",
      });
    }
    const pool = buildDrillPool(
      { type: "all" },
      { db: handle.db, limit: DEFAULT_DRILL_LIMIT, seed: 42 },
    );
    expect(pool.questions.length).toBe(DEFAULT_DRILL_LIMIT);
    expect(pool.availableCount).toBe(15);
    handle.close();
  });

  it("seeded shuffle is deterministic for a given seed", () => {
    for (let i = 0; i < 8; i++) {
      seedQuestion(handle.db, {
        id: `Q${i}`,
        taskStatementId: "TS1",
      });
    }
    const a = buildDrillPool({ type: "all" }, { db: handle.db, seed: 7 });
    const b = buildDrillPool({ type: "all" }, { db: handle.db, seed: 7 });
    expect(a.questions.map((q) => q.id)).toEqual(b.questions.map((q) => q.id));
    handle.close();
  });

  it("populates task statement title and domain on each question", () => {
    seedQuestion(handle.db, { id: "Q1", taskStatementId: "TS2" });
    const pool = buildDrillPool({ type: "all" }, { db: handle.db });
    expect(pool.questions[0].taskStatementTitle).toBe("Task 2");
    expect(pool.questions[0].domainId).toBe("D1");
    handle.close();
  });
});

describe("countQuestionsByScope", () => {
  let handle: ReturnType<typeof freshDb>;
  beforeEach(() => {
    handle = freshDb();
    seedCurriculum(handle.db);
  });

  it("rolls up counts by domain, task statement, and scenario", () => {
    seedQuestion(handle.db, { id: "Q1", taskStatementId: "TS1" });
    seedQuestion(handle.db, { id: "Q2", taskStatementId: "TS1" });
    seedQuestion(handle.db, {
      id: "Q3",
      taskStatementId: "TS2",
      scenarioId: "SC1",
    });
    seedQuestion(handle.db, { id: "Q4", taskStatementId: "TS3" });
    seedQuestion(handle.db, {
      id: "Q5",
      taskStatementId: "TS3",
      status: "retired",
    });
    const c = countQuestionsByScope(handle.db);
    expect(c.total).toBe(4);
    expect(c.byDomain).toEqual(
      expect.arrayContaining([
        { key: "D1", count: 3 },
        { key: "D2", count: 1 },
      ]),
    );
    expect(c.byTaskStatement).toEqual(
      expect.arrayContaining([
        { key: "TS1", count: 2 },
        { key: "TS2", count: 1 },
        { key: "TS3", count: 1 },
      ]),
    );
    expect(c.byScenario).toEqual([{ key: "SC1", count: 1 }]);
    handle.close();
  });

  it("returns zero total on empty DB", () => {
    const c = countQuestionsByScope(handle.db);
    expect(c.total).toBe(0);
    expect(c.byDomain).toEqual([]);
    expect(c.byTaskStatement).toEqual([]);
    expect(c.byScenario).toEqual([]);
    handle.close();
  });
});
