import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../lib/db";
import { schema } from "../lib/db";

const callClaudeMock = vi.fn();
vi.mock("../lib/claude/client", async () => {
  const actual = await vi.importActual<typeof import("../lib/claude/client")>(
    "../lib/claude/client",
  );
  return {
    ...actual,
    callClaude: callClaudeMock,
  };
});

const {
  startTutorSession,
  getTutorSession,
  listTutorSessions,
  sendTutorTurn,
  deleteTutorSession,
  TutorSessionError,
} = await import("../lib/tutor/sessions");

const {
  revealAnswerTool,
  REVEAL_REASONS,
} = await import("../lib/claude/roles/tutor");

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

function seedTs(db: Db, id: string = "D1.1"): void {
  db.insert(schema.domains)
    .values({
      id: id.split(".")[0],
      title: `Domain ${id.split(".")[0]}`,
      weightBps: 5000,
      orderIndex: 1,
    })
    .onConflictDoNothing()
    .run();
  db.insert(schema.taskStatements)
    .values({
      id,
      domainId: id.split(".")[0],
      title: `TS ${id}`,
      knowledgeBullets: ["stop_reason semantics"],
      skillsBullets: ["budget guards"],
      orderIndex: 1,
    })
    .run();
}

function endTurn(text: string) {
  return {
    id: "msg_test",
    type: "message" as const,
    role: "assistant" as const,
    model: "claude-sonnet-4-6",
    stop_reason: "end_turn" as const,
    stop_sequence: null,
    usage: {
      input_tokens: 40,
      output_tokens: 60,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation: null,
      inference_geo: null,
      server_tool_use: null,
      service_tier: null,
    },
    content: [{ type: "text" as const, text }],
  };
}

describe("startTutorSession", () => {
  let handle: ReturnType<typeof freshDb>;
  beforeEach(() => {
    handle = freshDb();
    seedTs(handle.db);
  });

  it("creates a row with empty messages and matching topicId", () => {
    const s = startTutorSession("D1.1", handle.db);
    expect(s.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(s.topicId).toBe("D1.1");
    expect(s.messages).toEqual([]);
    expect(s.messageCount).toBe(0);
    expect(s.createdAt).toBeInstanceOf(Date);

    const row = handle.db
      .select()
      .from(schema.tutorSessions)
      .all()[0];
    expect(row.id).toBe(s.id);
    expect(row.topicId).toBe("D1.1");
    handle.close();
  });

  it("throws not_found for an unknown topic", () => {
    expect(() => startTutorSession("DX.9", handle.db)).toThrow(
      TutorSessionError,
    );
    handle.close();
  });
});

describe("getTutorSession / listTutorSessions", () => {
  it("retrieves a session by id and lists by topic/updatedAt", async () => {
    const handle = freshDb();
    seedTs(handle.db, "D1.1");
    seedTs(handle.db, "D2.1");

    const a = startTutorSession("D1.1", handle.db);
    // small delay to avoid collision on updatedAt
    await new Promise((r) => setTimeout(r, 2));
    const b = startTutorSession("D1.1", handle.db);
    await new Promise((r) => setTimeout(r, 2));
    const c = startTutorSession("D2.1", handle.db);

    const fetched = getTutorSession(a.id, handle.db);
    expect(fetched.id).toBe(a.id);

    const d1 = listTutorSessions(handle.db, { topicId: "D1.1" });
    expect(d1.map((s) => s.id)).toEqual([b.id, a.id]); // most recent first

    const all = listTutorSessions(handle.db);
    expect(all.map((s) => s.id)).toEqual([c.id, b.id, a.id]);
    handle.close();
  });

  it("throws not_found for an unknown sessionId", () => {
    const handle = freshDb();
    expect(() =>
      getTutorSession("does-not-exist", handle.db),
    ).toThrow(TutorSessionError);
    handle.close();
  });
});

describe("sendTutorTurn", () => {
  let handle: ReturnType<typeof freshDb>;
  beforeEach(() => {
    handle = freshDb();
    seedTs(handle.db);
    callClaudeMock.mockReset();
  });

  it("appends messages and persists them across turns", async () => {
    const s = startTutorSession("D1.1", handle.db);
    callClaudeMock.mockResolvedValueOnce(endTurn("First response."));
    const r1 = await sendTutorTurn(s.id, "First user message.", {
      db: handle.db,
    });
    expect(r1.session.messageCount).toBe(2); // user + assistant

    callClaudeMock.mockResolvedValueOnce(endTurn("Second response."));
    const r2 = await sendTutorTurn(s.id, "Second user message.", {
      db: handle.db,
    });
    expect(r2.session.messageCount).toBe(4); // 2 prior + user + assistant

    // Re-fetch from DB and confirm persistence.
    const reloaded = getTutorSession(s.id, handle.db);
    expect(reloaded.messageCount).toBe(4);
    expect(reloaded.messages[0]).toMatchObject({ role: "user" });
    expect(reloaded.messages[2]).toMatchObject({ role: "user" });
    handle.close();
  });

  it("throws not_found when sessionId does not exist", async () => {
    await expect(
      sendTutorTurn("nope", "hello", { db: handle.db }),
    ).rejects.toBeInstanceOf(TutorSessionError);
    handle.close();
  });

  it("updates updatedAt on each turn", async () => {
    const s = startTutorSession("D1.1", handle.db);
    callClaudeMock.mockResolvedValueOnce(endTurn("ok"));
    const r = await sendTutorTurn(s.id, "hi", {
      db: handle.db,
      now: s.createdAt.getTime() + 10_000,
    });
    expect(r.session.updatedAt.getTime()).toBeGreaterThan(
      s.createdAt.getTime(),
    );
    handle.close();
  });
});

describe("deleteTutorSession", () => {
  it("removes the row and reports deleted=true only on first call", () => {
    const handle = freshDb();
    seedTs(handle.db);
    const s = startTutorSession("D1.1", handle.db);
    expect(deleteTutorSession(s.id, handle.db)).toEqual({ deleted: true });
    expect(deleteTutorSession(s.id, handle.db)).toEqual({ deleted: false });
    handle.close();
  });
});

describe("reveal_answer tool (D5.2 escalation)", () => {
  let handle: ReturnType<typeof freshDb>;
  beforeEach(() => {
    handle = freshDb();
    seedTs(handle.db);
  });

  it("accepts each D5.2 reason and writes a success=false tutor_signal event", () => {
    const tool = revealAnswerTool(handle.db);
    for (const reason of REVEAL_REASONS) {
      const v = tool.validateInput({
        task_statement_id: "D1.1",
        bloom_level: 3,
        reason,
        note: `trigger was ${reason}`,
      });
      if (!("ok" in v && v.ok)) throw new Error("validation failed");
      const res = tool.handler(v.value);
      if (!("ok" in res && res.ok)) throw new Error("handler failed");
      expect(res.data.reason).toBe(reason);
    }
    const events = handle.db
      .select()
      .from(schema.progressEvents)
      .all();
    expect(events).toHaveLength(3);
    for (const e of events) {
      expect(e.kind).toBe("tutor_signal");
      expect(e.success).toBe(false);
      expect(e.payload).toHaveProperty("escalation");
    }
    handle.close();
  });

  it("rejects an unknown reason with a validation error", () => {
    const tool = revealAnswerTool(handle.db);
    const v = tool.validateInput({
      task_statement_id: "D1.1",
      bloom_level: 2,
      reason: "gave_up", // not in REVEAL_REASONS
    });
    expect(v).toMatchObject({
      isError: true,
      errorCategory: "validation",
    });
    handle.close();
  });

  it("returns business error when TS does not exist", () => {
    const tool = revealAnswerTool(handle.db);
    const v = tool.validateInput({
      task_statement_id: "DX.9",
      bloom_level: 2,
      reason: "explicit_ask",
    });
    if (!("ok" in v && v.ok)) throw new Error("validation failed");
    const res = tool.handler(v.value);
    expect(res).toMatchObject({
      isError: true,
      errorCategory: "business",
      isRetryable: false,
    });
    handle.close();
  });

  it("is included in the tutor tool set", async () => {
    const { buildTutorToolSet } = await import("../lib/claude/roles/tutor");
    const set = buildTutorToolSet(handle.db);
    expect(set.tools).toHaveLength(4);
    expect(set.byName.has("reveal_answer")).toBe(true);
    handle.close();
  });
});
