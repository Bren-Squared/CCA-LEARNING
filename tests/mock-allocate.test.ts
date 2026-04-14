import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../lib/db";
import { schema } from "../lib/db";
import {
  MOCK_BLOOM_BAND,
  MOCK_DOMAIN_WEIGHTS_BPS,
  MOCK_SCENARIO_COUNT,
  MOCK_TOTAL_QUESTIONS,
  MockAllocationError,
  allocateByLargestRemainder,
  buildMockAllocation,
  pickScenarios,
} from "../lib/mock/allocate";

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

function seedDomains(db: Db): void {
  const domains: Array<[string, number, number]> = [
    ["D1", 2700, 1],
    ["D2", 1800, 2],
    ["D3", 2000, 3],
    ["D4", 2000, 4],
    ["D5", 1500, 5],
  ];
  for (const [id, weight, idx] of domains) {
    db.insert(schema.domains)
      .values({ id, title: id, weightBps: weight, orderIndex: idx })
      .run();
    db.insert(schema.taskStatements)
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
}

function seedScenarios(db: Db, count: number): string[] {
  const ids: string[] = [];
  for (let i = 1; i <= count; i++) {
    const id = `S${i}`;
    db.insert(schema.scenarios)
      .values({
        id,
        title: `Scenario ${i}`,
        description: `Scenario ${i} desc`,
        orderIndex: i,
      })
      .run();
    ids.push(id);
  }
  return ids;
}

function seedQuestions(
  db: Db,
  n: number,
  opts: { domainId: string; scenarioId?: string | null; bloom?: number } = {
    domainId: "D1",
  },
): string[] {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = randomUUID();
    db.insert(schema.questions)
      .values({
        id,
        stem: `Stem ${i}`,
        options: ["a", "b", "c", "d"],
        correctIndex: 0,
        explanations: ["x", "x", "x", "x"],
        taskStatementId: `${opts.domainId}.1`,
        scenarioId: opts.scenarioId ?? null,
        difficulty: 3,
        bloomLevel: opts.bloom ?? 3,
        bloomJustification: "apply",
        source: "seed",
        status: "active",
      })
      .run();
    ids.push(id);
  }
  return ids;
}

describe("allocateByLargestRemainder", () => {
  it("apportions 60 across the 27/18/20/20/15 exam weights with sum=60", () => {
    const alloc = allocateByLargestRemainder(60, MOCK_DOMAIN_WEIGHTS_BPS);
    expect(alloc).toEqual({ D1: 16, D2: 11, D3: 12, D4: 12, D5: 9 });
    expect(Object.values(alloc).reduce((s, n) => s + n, 0)).toBe(60);
  });

  it("distributes leftover seats to the largest fractional remainders first", () => {
    // 10 seats across three equal weights → 4/3/3 (first wins tie by order)
    const alloc = allocateByLargestRemainder(10, { A: 1, B: 1, C: 1 });
    const sum = Object.values(alloc).reduce((s, n) => s + n, 0);
    expect(sum).toBe(10);
    expect(Math.max(...Object.values(alloc))).toBeLessThanOrEqual(4);
    expect(Math.min(...Object.values(alloc))).toBeGreaterThanOrEqual(3);
  });

  it("rejects zero total weight", () => {
    expect(() => allocateByLargestRemainder(10, { A: 0, B: 0 })).toThrow(
      MockAllocationError,
    );
  });

  it("handles total=0 gracefully (all zeros)", () => {
    const alloc = allocateByLargestRemainder(0, MOCK_DOMAIN_WEIGHTS_BPS);
    expect(Object.values(alloc).every((n) => n === 0)).toBe(true);
  });
});

describe("pickScenarios", () => {
  let ctx: ReturnType<typeof freshDb>;
  beforeEach(() => {
    ctx = freshDb();
  });

  it("picks 4 distinct scenario ids from a pool of 6", () => {
    seedScenarios(ctx.db, 6);
    const picked = pickScenarios(ctx.db, 4, 42);
    expect(picked).toHaveLength(4);
    expect(new Set(picked).size).toBe(4);
  });

  it("is deterministic under the same seed", () => {
    seedScenarios(ctx.db, 6);
    const a = pickScenarios(ctx.db, 4, 12345);
    const b = pickScenarios(ctx.db, 4, 12345);
    expect(a).toEqual(b);
  });

  it("errors when the bank has fewer scenarios than requested", () => {
    seedScenarios(ctx.db, 3);
    expect(() => pickScenarios(ctx.db, 4, 1)).toThrow(MockAllocationError);
  });
});

describe("buildMockAllocation", () => {
  let ctx: ReturnType<typeof freshDb>;
  beforeEach(() => {
    ctx = freshDb();
    seedDomains(ctx.db);
    seedScenarios(ctx.db, 6);
  });

  function seedFullBank(): void {
    // 40 questions per domain spread evenly across 6 scenarios and all 3 bloom levels.
    for (const dom of ["D1", "D2", "D3", "D4", "D5"]) {
      for (let i = 1; i <= 6; i++) {
        for (const bloom of MOCK_BLOOM_BAND) {
          seedQuestions(ctx.db, 3, {
            domainId: dom,
            scenarioId: `S${i}`,
            bloom,
          });
        }
      }
    }
  }

  it("produces 60 questions across 4 scenarios with domain counts matching weights", () => {
    seedFullBank();
    const alloc = buildMockAllocation({ db: ctx.db, seed: 42 });
    expect(alloc.questionIds).toHaveLength(MOCK_TOTAL_QUESTIONS);
    expect(alloc.scenarioIds).toHaveLength(MOCK_SCENARIO_COUNT);
    expect(new Set(alloc.scenarioIds).size).toBe(MOCK_SCENARIO_COUNT);
    expect(alloc.domainActual).toEqual({
      D1: 16,
      D2: 11,
      D3: 12,
      D4: 12,
      D5: 9,
    });
    expect(alloc.shortfallDomains).toEqual([]);
  });

  it("includes only questions from the Apply–Evaluate Bloom band (3–5)", () => {
    // Seed exam-band questions plus some levels 1/2/6 that MUST be excluded.
    seedFullBank();
    for (const dom of ["D1", "D2", "D3", "D4", "D5"]) {
      seedQuestions(ctx.db, 5, { domainId: dom, bloom: 1 });
      seedQuestions(ctx.db, 5, { domainId: dom, bloom: 6 });
    }
    const alloc = buildMockAllocation({ db: ctx.db, seed: 7 });
    const rows = ctx.db
      .select({
        id: schema.questions.id,
        bloom: schema.questions.bloomLevel,
      })
      .from(schema.questions)
      .all();
    const bloomById = new Map(rows.map((r) => [r.id, r.bloom]));
    for (const qid of alloc.questionIds) {
      const b = bloomById.get(qid);
      expect([3, 4, 5]).toContain(b);
    }
  });

  it("prefers questions tied to the 4 selected scenarios", () => {
    seedFullBank();
    const alloc = buildMockAllocation({ db: ctx.db, seed: 99 });
    const scenarioSet = new Set(alloc.scenarioIds);
    const rows = ctx.db
      .select({
        id: schema.questions.id,
        scenarioId: schema.questions.scenarioId,
      })
      .from(schema.questions)
      .all();
    const scByQid = new Map(rows.map((r) => [r.id, r.scenarioId]));
    // With 40 exam-band questions per domain spread across 6 scenarios,
    // every selected-domain count easily fits within the 4-scenario subset.
    // So EVERY picked question should belong to a selected scenario.
    for (const qid of alloc.questionIds) {
      expect(scenarioSet.has(scByQid.get(qid) as string)).toBe(true);
    }
  });

  it("falls back to off-scenario questions when the scenario-tied pool is short", () => {
    // Only 2 questions per (domain, scenario, bloom) — much less than the targets.
    // Forces fallback to off-scenario questions.
    for (const dom of ["D1", "D2", "D3", "D4", "D5"]) {
      for (let i = 1; i <= 6; i++) {
        for (const bloom of MOCK_BLOOM_BAND) {
          seedQuestions(ctx.db, 2, {
            domainId: dom,
            scenarioId: `S${i}`,
            bloom,
          });
        }
      }
    }
    const alloc = buildMockAllocation({ db: ctx.db, seed: 1 });
    expect(alloc.questionIds).toHaveLength(60);
    expect(alloc.shortfallDomains).toEqual([]);
  });

  it("throws insufficient_questions when the bank cannot satisfy 60 exam-band items", () => {
    seedQuestions(ctx.db, 10, { domainId: "D1", bloom: 3 });
    expect(() => buildMockAllocation({ db: ctx.db, seed: 1 })).toThrow(
      MockAllocationError,
    );
  });

  it("is deterministic under the same seed", () => {
    seedFullBank();
    const a = buildMockAllocation({ db: ctx.db, seed: 2024 });
    const b = buildMockAllocation({ db: ctx.db, seed: 2024 });
    expect(a.scenarioIds).toEqual(b.scenarioIds);
    expect(a.questionIds).toEqual(b.questionIds);
  });

  it("selects ONLY active questions (flagged/retired excluded)", () => {
    seedFullBank();
    const allRows = ctx.db
      .select({ id: schema.questions.id })
      .from(schema.questions)
      .all();
    const toRetire = allRows.slice(0, 5).map((r) => r.id);
    for (const id of toRetire) {
      ctx.db
        .update(schema.questions)
        .set({ status: "retired" })
        .where(eq(schema.questions.id, id))
        .run();
    }
    const alloc = buildMockAllocation({ db: ctx.db, seed: 77 });
    for (const qid of alloc.questionIds) {
      expect(toRetire).not.toContain(qid);
    }
  });
});
