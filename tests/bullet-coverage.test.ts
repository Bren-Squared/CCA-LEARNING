import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../lib/db";
import { schema } from "../lib/db";
import { buildCoverageReport } from "../lib/study/coverage";
import {
  persistApprovedQuestion,
  validateBulletIdxs,
} from "../lib/study/generator";

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

function seedTs(
  db: Db,
  id: string,
  knowledge: string[],
  skills: string[],
): typeof schema.taskStatements.$inferSelect {
  db.insert(schema.domains)
    .values({ id: "D1", title: "Domain 1", weightBps: 10000, orderIndex: 1 })
    .onConflictDoNothing()
    .run();
  db.insert(schema.taskStatements)
    .values({
      id,
      domainId: "D1",
      title: `Task ${id}`,
      knowledgeBullets: knowledge,
      skillsBullets: skills,
      orderIndex: 1,
    })
    .run();
  return db
    .select()
    .from(schema.taskStatements)
    .where(eq(schema.taskStatements.id, id))
    .get()!;
}

describe("validateBulletIdxs (E3 / Phase 16)", () => {
  let handle: ReturnType<typeof freshDb>;
  beforeEach(() => {
    handle = freshDb();
  });

  it("rejects when both arrays are empty", () => {
    const ts = seedTs(handle.db, "D1.1", ["k0", "k1"], ["s0"]);
    const v = validateBulletIdxs(
      { knowledge_bullet_idxs: [], skills_bullet_idxs: [] },
      ts,
    );
    expect(v?.code).toBe("empty");
    handle.close();
  });

  it("rejects out-of-range knowledge indices", () => {
    const ts = seedTs(handle.db, "D1.1", ["k0", "k1"], ["s0"]);
    const v = validateBulletIdxs(
      { knowledge_bullet_idxs: [2], skills_bullet_idxs: [] },
      ts,
    );
    expect(v?.code).toBe("out_of_range");
    expect(v?.detail).toContain("knowledge_bullet_idxs");
    handle.close();
  });

  it("rejects out-of-range skills indices", () => {
    const ts = seedTs(handle.db, "D1.1", ["k0"], ["s0", "s1"]);
    const v = validateBulletIdxs(
      { knowledge_bullet_idxs: [0], skills_bullet_idxs: [5] },
      ts,
    );
    expect(v?.code).toBe("out_of_range");
    expect(v?.detail).toContain("skills_bullet_idxs");
    handle.close();
  });

  it("accepts in-range non-empty citations", () => {
    const ts = seedTs(handle.db, "D1.1", ["k0", "k1"], ["s0"]);
    expect(
      validateBulletIdxs(
        { knowledge_bullet_idxs: [0, 1], skills_bullet_idxs: [0] },
        ts,
      ),
    ).toBeNull();
    expect(
      validateBulletIdxs(
        { knowledge_bullet_idxs: [], skills_bullet_idxs: [0] },
        ts,
      ),
    ).toBeNull();
    handle.close();
  });
});

describe("persistApprovedQuestion writes bullet idxs", () => {
  let handle: ReturnType<typeof freshDb>;
  beforeEach(() => {
    handle = freshDb();
  });

  it("stores both arrays on the row", () => {
    const ts = seedTs(handle.db, "D1.1", ["k0", "k1"], ["s0"]);
    const id = persistApprovedQuestion(
      ts,
      null,
      {
        stem: "test stem long enough",
        options: ["a", "b", "c", "d"],
        correct_index: 0,
        explanations: ["x".repeat(15), "y".repeat(15), "z".repeat(15), "w".repeat(15)],
        bloom_level: 3,
        bloom_justification: "applies a method",
        difficulty: 3,
        knowledge_bullet_idxs: [0, 1],
        skills_bullet_idxs: [0],
      },
      handle.db,
    );
    const row = handle.db
      .select()
      .from(schema.questions)
      .where(eq(schema.questions.id, id))
      .get();
    expect(row?.knowledgeBulletIdxs).toEqual([0, 1]);
    expect(row?.skillsBulletIdxs).toEqual([0]);
    handle.close();
  });
});

describe("buildCoverageReport · bullet coverage", () => {
  let handle: ReturnType<typeof freshDb>;
  beforeEach(() => {
    handle = freshDb();
  });

  function insertQ(
    db: Db,
    tsId: string,
    bloom: number,
    kIdxs: number[],
    sIdxs: number[],
    id?: string,
  ): string {
    const qid = id ?? `q-${tsId}-${bloom}-${kIdxs.join(",")}-${sIdxs.join(",")}`;
    db.insert(schema.questions)
      .values({
        id: qid,
        taskStatementId: tsId,
        stem: "x",
        options: ["a", "b", "c", "d"],
        correctIndex: 0,
        explanations: ["", "", "", ""],
        difficulty: 2,
        bloomLevel: bloom,
        bloomJustification: "t",
        knowledgeBulletIdxs: kIdxs,
        skillsBulletIdxs: sIdxs,
        source: "generated",
        status: "active",
      })
      .run();
    return qid;
  }

  it("produces one row per TS bullet with the correct citation count", () => {
    seedTs(handle.db, "D1.1", ["k0", "k1"], ["s0"]);
    insertQ(handle.db, "D1.1", 3, [0], []);
    insertQ(handle.db, "D1.1", 3, [0, 1], [0]);

    const report = buildCoverageReport(handle.db);
    const k0 = report.bulletCoverage.find(
      (b) => b.kind === "knowledge" && b.bulletIdx === 0,
    );
    const k1 = report.bulletCoverage.find(
      (b) => b.kind === "knowledge" && b.bulletIdx === 1,
    );
    const s0 = report.bulletCoverage.find(
      (b) => b.kind === "skills" && b.bulletIdx === 0,
    );
    expect(k0?.questionCount).toBe(2);
    expect(k1?.questionCount).toBe(1);
    expect(s0?.questionCount).toBe(1);
    handle.close();
  });

  it("blind-spot list captures bullets with zero citations", () => {
    seedTs(handle.db, "D1.1", ["k0", "k1", "k2"], ["s0"]);
    insertQ(handle.db, "D1.1", 3, [0], []);
    // k1, k2, s0 all uncovered

    const report = buildCoverageReport(handle.db);
    expect(report.bulletBlindSpots.map((b) => `${b.kind}:${b.bulletIdx}`)).toEqual([
      "knowledge:1",
      "knowledge:2",
      "skills:0",
    ]);
    expect(report.totals.bulletBlindSpotCount).toBe(3);
    handle.close();
  });

  it("counts questions missing both citation arrays", () => {
    seedTs(handle.db, "D1.1", ["k0"], ["s0"]);
    insertQ(handle.db, "D1.1", 3, [], [], "legacy");
    insertQ(handle.db, "D1.1", 3, [0], [], "ok");

    const report = buildCoverageReport(handle.db);
    expect(report.totals.questionsMissingBulletCitations).toBe(1);
    handle.close();
  });

  it("retired/flagged questions don't count toward bullet coverage", () => {
    seedTs(handle.db, "D1.1", ["k0"], ["s0"]);
    const qid = insertQ(handle.db, "D1.1", 3, [0], [0]);
    handle.db
      .update(schema.questions)
      .set({ status: "retired" })
      .where(eq(schema.questions.id, qid))
      .run();
    const report = buildCoverageReport(handle.db);
    const k0 = report.bulletCoverage.find(
      (b) => b.kind === "knowledge" && b.bulletIdx === 0,
    );
    const s0 = report.bulletCoverage.find(
      (b) => b.kind === "skills" && b.bulletIdx === 0,
    );
    expect(k0?.questionCount).toBe(0);
    expect(s0?.questionCount).toBe(0);
    expect(report.totals.bulletBlindSpotCount).toBe(2);
    handle.close();
  });
});
