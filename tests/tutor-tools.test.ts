import Database from "better-sqlite3";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../lib/db";
import { schema } from "../lib/db";
import {
  buildTutorToolSet,
  lookupBulletsTool,
  recordMasteryTool,
  spawnPracticeQuestionTool,
} from "../lib/claude/roles/tutor";

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

function seedDomainTs(db: Db): void {
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

function seedQuestion(
  db: Db,
  overrides: Partial<typeof schema.questions.$inferInsert> = {},
): string {
  const id = overrides.id ?? "q1";
  db.insert(schema.questions)
    .values({
      id,
      stem: "Which stop_reason terminates the agentic loop?",
      options: ["tool_use", "end_turn", "max_tokens", "stop_sequence"],
      correctIndex: 1,
      explanations: [
        "tool_use continues the loop",
        "end_turn is the normal terminator",
        "max_tokens is truncation",
        "stop_sequence we don't use",
      ],
      taskStatementId: "D1.1",
      difficulty: 2,
      bloomLevel: 2,
      bloomJustification: "Recall + distinguish among stop reasons",
      source: "seed",
      status: "active",
      ...overrides,
    })
    .run();
  return id;
}

describe("lookup_bullets tool", () => {
  let handle: ReturnType<typeof freshDb>;
  beforeEach(() => {
    handle = freshDb();
    seedDomainTs(handle.db);
  });

  it("returns verbatim bullets for a valid task statement id", () => {
    const tool = lookupBulletsTool(handle.db);
    const v = tool.validateInput({ task_statement_id: "D1.1" });
    expect("ok" in v && v.ok).toBe(true);
    if (!("ok" in v && v.ok)) throw new Error("validation failed");
    const result = tool.handler(v.value);
    expect(result).toMatchObject({
      ok: true,
      data: {
        task_statement_id: "D1.1",
        title: "Analyze agentic loops",
        knowledge_bullets: ["stop_reason semantics", "tool_use cycles"],
        skills_bullets: ["choosing max iterations", "budget guards"],
      },
    });
    handle.close();
  });

  it("returns a business error for an unknown id", () => {
    const tool = lookupBulletsTool(handle.db);
    const v = tool.validateInput({ task_statement_id: "DX.9" });
    if (!("ok" in v && v.ok)) throw new Error("validation failed");
    const result = tool.handler(v.value);
    expect(result).toMatchObject({
      isError: true,
      errorCategory: "business",
      isRetryable: false,
    });
    handle.close();
  });

  it("returns a validation error when id is missing", () => {
    const tool = lookupBulletsTool(handle.db);
    const v = tool.validateInput({});
    expect(v).toMatchObject({ isError: true, errorCategory: "validation" });
    handle.close();
  });
});

describe("record_mastery tool", () => {
  let handle: ReturnType<typeof freshDb>;
  beforeEach(() => {
    handle = freshDb();
    seedDomainTs(handle.db);
  });

  it("writes a tutor_signal progress event and refreshes snapshot on success", () => {
    const tool = recordMasteryTool(handle.db);
    const v = tool.validateInput({
      task_statement_id: "D1.1",
      bloom_level: 2,
      outcome: "success",
      note: "User explained stop_reason correctly.",
    });
    if (!("ok" in v && v.ok)) throw new Error("validation failed");
    const result = tool.handler(v.value);
    if (!("ok" in result && result.ok)) throw new Error("handler failed");
    expect(result.data.event_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.data.bloom_level).toBe(2);
    expect(result.data.outcome).toBe("success");
    expect(result.data.item_count).toBe(1);

    // Verify event is persisted.
    const events = handle.db
      .select()
      .from(schema.progressEvents)
      .where(
        and(
          eq(schema.progressEvents.taskStatementId, "D1.1"),
          eq(schema.progressEvents.bloomLevel, 2),
        ),
      )
      .all();
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("tutor_signal");
    expect(events[0].success).toBe(true);
    expect(events[0].payload).toMatchObject({
      note: "User explained stop_reason correctly.",
    });

    // Snapshot is refreshed.
    const snap = handle.db
      .select()
      .from(schema.masterySnapshots)
      .where(
        and(
          eq(schema.masterySnapshots.taskStatementId, "D1.1"),
          eq(schema.masterySnapshots.bloomLevel, 2),
        ),
      )
      .get();
    expect(snap?.itemCount).toBe(1);
    expect(snap?.score).toBeGreaterThan(0);
    handle.close();
  });

  it("writes success=false when outcome is failure", () => {
    const tool = recordMasteryTool(handle.db);
    const v = tool.validateInput({
      task_statement_id: "D1.1",
      bloom_level: 3,
      outcome: "failure",
    });
    if (!("ok" in v && v.ok)) throw new Error("validation failed");
    const result = tool.handler(v.value);
    if (!("ok" in result && result.ok)) throw new Error("handler failed");
    expect(result.data.outcome).toBe("failure");
    const events = handle.db
      .select()
      .from(schema.progressEvents)
      .where(eq(schema.progressEvents.bloomLevel, 3))
      .all();
    expect(events[0].success).toBe(false);
    handle.close();
  });

  it("returns business error when TS does not exist", () => {
    const tool = recordMasteryTool(handle.db);
    const v = tool.validateInput({
      task_statement_id: "DX.9",
      bloom_level: 1,
      outcome: "success",
    });
    if (!("ok" in v && v.ok)) throw new Error("validation failed");
    const result = tool.handler(v.value);
    expect(result).toMatchObject({
      isError: true,
      errorCategory: "business",
      isRetryable: false,
    });
    handle.close();
  });

  it("returns validation error for bloom_level out of range", () => {
    const tool = recordMasteryTool(handle.db);
    expect(
      tool.validateInput({
        task_statement_id: "D1.1",
        bloom_level: 7,
        outcome: "success",
      }),
    ).toMatchObject({ isError: true, errorCategory: "validation" });
    expect(
      tool.validateInput({
        task_statement_id: "D1.1",
        bloom_level: 0,
        outcome: "success",
      }),
    ).toMatchObject({ isError: true, errorCategory: "validation" });
    handle.close();
  });
});

describe("spawn_practice_question tool", () => {
  let handle: ReturnType<typeof freshDb>;
  beforeEach(() => {
    handle = freshDb();
    seedDomainTs(handle.db);
  });

  it("returns a question at the requested cell including correct_index", () => {
    seedQuestion(handle.db);
    const tool = spawnPracticeQuestionTool(handle.db);
    const v = tool.validateInput({
      task_statement_id: "D1.1",
      bloom_level: 2,
    });
    if (!("ok" in v && v.ok)) throw new Error("validation failed");
    const result = tool.handler(v.value);
    if (!("ok" in result && result.ok)) throw new Error("handler failed");
    expect(result.data.question_id).toBe("q1");
    expect(result.data.options).toHaveLength(4);
    expect(result.data.correct_index).toBe(1);
    expect(result.data.correct_explanation).toContain("normal terminator");
    expect(result.data.bloom_level).toBe(2);
    handle.close();
  });

  it("returns a business error when no active questions exist at the cell", () => {
    seedQuestion(handle.db, { status: "flagged" });
    const tool = spawnPracticeQuestionTool(handle.db);
    const v = tool.validateInput({
      task_statement_id: "D1.1",
      bloom_level: 2,
    });
    if (!("ok" in v && v.ok)) throw new Error("validation failed");
    const result = tool.handler(v.value);
    expect(result).toMatchObject({
      isError: true,
      errorCategory: "business",
      isRetryable: false,
    });
    handle.close();
  });

  it("does not return retired questions", () => {
    seedQuestion(handle.db, { id: "q_active", status: "active" });
    seedQuestion(handle.db, { id: "q_retired", status: "retired" });
    const tool = spawnPracticeQuestionTool(handle.db);
    const v = tool.validateInput({
      task_statement_id: "D1.1",
      bloom_level: 2,
    });
    if (!("ok" in v && v.ok)) throw new Error("validation failed");
    // Run many times to cover any random sampling; only q_active should appear.
    for (let i = 0; i < 20; i++) {
      const result = tool.handler(v.value);
      if (!("ok" in result && result.ok)) throw new Error("handler failed");
      expect(result.data.question_id).toBe("q_active");
    }
    handle.close();
  });
});

describe("buildTutorToolSet", () => {
  it("returns four tools indexed by name (incl. reveal_answer for D5.2)", () => {
    const handle = freshDb();
    const set = buildTutorToolSet(handle.db);
    expect(set.tools).toHaveLength(4);
    expect(set.byName.has("lookup_bullets")).toBe(true);
    expect(set.byName.has("record_mastery")).toBe(true);
    expect(set.byName.has("spawn_practice_question")).toBe(true);
    expect(set.byName.has("reveal_answer")).toBe(true);
    handle.close();
  });
});
