import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  countIngested,
  persistCurriculum,
  readIngestHash,
  writeIngestHash,
} from "../lib/curriculum/ingest";
import { parseCurriculumText } from "../lib/curriculum/parser";
import type { Db } from "../lib/db";
import { schema } from "../lib/db";
import { buildSyntheticGuide } from "./fixtures/exam-guide-synthetic";

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
  const db = drizzle(sqlite, { schema });
  return { db, close: () => sqlite.close() };
}

describe("persistCurriculum (idempotency + coverage)", () => {
  const text = buildSyntheticGuide();
  const curriculum = parseCurriculumText(text);
  const bloomStub = curriculum.questions.map((q) => ({
    questionId: q.id,
    bloomLevel: 3 as const,
    justification: "test stub",
  }));

  let handle: ReturnType<typeof freshDb>;
  beforeEach(() => {
    handle = freshDb();
  });

  it("persists 5 / 30 / 6 / 12 / 4 on first run (AT1 coverage)", () => {
    persistCurriculum(handle.db, curriculum, bloomStub);
    const counts = countIngested(handle.db);
    expect(counts).toEqual({
      domains: 5,
      taskStatements: 30,
      scenarios: 6,
      questions: 12,
      exercises: 4,
    });
    handle.close();
  });

  it("re-running is a no-op — no duplicates (FR1.3)", () => {
    persistCurriculum(handle.db, curriculum, bloomStub);
    persistCurriculum(handle.db, curriculum, bloomStub);
    persistCurriculum(handle.db, curriculum, bloomStub);
    const counts = countIngested(handle.db);
    expect(counts).toEqual({
      domains: 5,
      taskStatements: 30,
      scenarios: 6,
      questions: 12,
      exercises: 4,
    });
    handle.close();
  });

  it("round-trips the ingest hash", () => {
    writeIngestHash(handle.db, "abc123", new Date());
    expect(readIngestHash(handle.db)).toBe("abc123");
    writeIngestHash(handle.db, "def456", new Date());
    expect(readIngestHash(handle.db)).toBe("def456");
    handle.close();
  });
});
