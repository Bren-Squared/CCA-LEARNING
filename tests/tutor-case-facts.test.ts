import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../lib/db";
import { schema } from "../lib/db";
import {
  buildCaseFacts,
  CaseFactsError,
  caseFactsToPromptInputs,
} from "../lib/tutor/case-facts";
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

function seedTs(db: Db): void {
  db.insert(schema.domains)
    .values({ id: "D1", title: "Domain 1", weightBps: 5000, orderIndex: 1 })
    .run();
  db.insert(schema.taskStatements)
    .values({
      id: "D1.1",
      domainId: "D1",
      title: "Analyze agentic loops",
      knowledgeBullets: ["stop_reason semantics", "tool_use cycles"],
      skillsBullets: ["choosing max iterations", "budget guards"],
      orderIndex: 1,
    })
    .run();
}

describe("buildCaseFacts", () => {
  let handle: ReturnType<typeof freshDb>;
  beforeEach(() => {
    handle = freshDb();
    seedTs(handle.db);
  });

  it("returns bullets + ceiling=0 + nextLevel=1 for a fresh topic", () => {
    const cf = buildCaseFacts("D1.1", { db: handle.db });
    expect(cf.taskStatementId).toBe("D1.1");
    expect(cf.title).toBe("Analyze agentic loops");
    expect(cf.domainId).toBe("D1");
    expect(cf.knowledgeBullets).toEqual([
      "stop_reason semantics",
      "tool_use cycles",
    ]);
    expect(cf.ceiling).toBe(0);
    expect(cf.nextLevel).toBe(1);
    expect(cf.recentMisses).toEqual([]);
    handle.close();
  });

  it("surfaces the last 5 failures, most-recent-first", () => {
    // Insert 6 failures across different timestamps.
    const now = Date.now();
    for (let i = 0; i < 6; i++) {
      writeProgressEvent(
        {
          kind: "tutor_signal",
          taskStatementId: "D1.1",
          bloomLevel: 1,
          success: false,
          payload: { note: `miss-${i}` },
          ts: new Date(now - (6 - i) * 60_000),
        },
        handle.db,
      );
    }
    const cf = buildCaseFacts("D1.1", { db: handle.db, now });
    expect(cf.recentMisses).toHaveLength(5);
    // Most recent first: miss-5, miss-4, ..., miss-1
    expect(cf.recentMisses[0].note).toBe("miss-5");
    expect(cf.recentMisses[4].note).toBe("miss-1");
    handle.close();
  });

  it("throws CaseFactsError not_found for an unknown id", () => {
    expect(() => buildCaseFacts("DX.9", { db: handle.db })).toThrow(
      CaseFactsError,
    );
    handle.close();
  });

  it("raises ceiling to L1 after 5 decay-weighted successes", () => {
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      writeProgressEvent(
        {
          kind: "tutor_signal",
          taskStatementId: "D1.1",
          bloomLevel: 1,
          success: true,
          ts: new Date(now - i * 1000),
        },
        handle.db,
      );
    }
    const cf = buildCaseFacts("D1.1", { db: handle.db, now });
    expect(cf.ceiling).toBe(1);
    expect(cf.nextLevel).toBe(2);
    handle.close();
  });
});

describe("caseFactsToPromptInputs", () => {
  it("renders a clean slate when there are no misses", () => {
    const handle = freshDb();
    seedTs(handle.db);
    const cf = buildCaseFacts("D1.1", { db: handle.db });
    const inputs = caseFactsToPromptInputs(cf);
    expect(inputs.task_statement_id).toBe("D1.1");
    expect(inputs.domain_id).toBe("D1");
    expect(inputs.ceiling).toBe("0");
    expect(inputs.next_level).toBe("1");
    expect(inputs.recent_misses).toContain("clean slate");
    expect(inputs.knowledge_bullets).toContain("stop_reason semantics");
    handle.close();
  });

  it("renders a bullet list of misses when present", () => {
    const handle = freshDb();
    seedTs(handle.db);
    writeProgressEvent(
      {
        kind: "tutor_signal",
        taskStatementId: "D1.1",
        bloomLevel: 2,
        success: false,
        payload: { note: "missed distinction between tool_use and end_turn" },
      },
      handle.db,
    );
    const cf = buildCaseFacts("D1.1", { db: handle.db });
    const inputs = caseFactsToPromptInputs(cf);
    expect(inputs.recent_misses).toContain("L2");
    expect(inputs.recent_misses).toContain("tutor_signal");
    expect(inputs.recent_misses).toContain("missed distinction");
    handle.close();
  });
});
