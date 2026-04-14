import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../lib/db";
import { schema } from "../lib/db";

// Mock Claude BEFORE importing the loop so the mock is live.
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

const { runTutorTurn } = await import("../lib/tutor/loop");
const { buildTutorToolSet } = await import("../lib/claude/roles/tutor");

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

interface FakeContentBlock {
  type: "text" | "tool_use";
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

function cannedResponse(
  stopReason: "end_turn" | "tool_use" | "max_tokens",
  content: FakeContentBlock[],
) {
  return {
    id: "msg_test",
    type: "message" as const,
    role: "assistant" as const,
    model: "claude-sonnet-4-6",
    stop_reason: stopReason,
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
    content,
  };
}

describe("runTutorTurn", () => {
  let handle: ReturnType<typeof freshDb>;

  beforeEach(() => {
    handle = freshDb();
    seedTs(handle.db);
    callClaudeMock.mockReset();
  });

  it("returns with 1 iteration when the first response is end_turn", async () => {
    callClaudeMock.mockResolvedValueOnce(
      cannedResponse("end_turn", [
        { type: "text", text: "What stop_reason terminates the loop?" },
      ]),
    );
    const res = await runTutorTurn({
      topicId: "D1.1",
      priorMessages: [],
      userMessage: "Start me out.",
      db: handle.db,
    });
    expect(res.iterationCount).toBe(1);
    expect(res.finalStopReason).toBe("end_turn");
    expect(res.finalAssistantText).toContain("stop_reason");
    expect(res.toolCalls).toHaveLength(0);
    expect(res.reachedIterationCap).toBe(false);
    // messages: user(new) + assistant(text)
    expect(res.messages).toHaveLength(2);
    expect(res.messages[0]).toMatchObject({ role: "user" });
    expect(res.messages[1]).toMatchObject({ role: "assistant" });
    handle.close();
  });

  it("executes a tool_use block and continues to end_turn (2 iterations)", async () => {
    callClaudeMock
      .mockResolvedValueOnce(
        cannedResponse("tool_use", [
          { type: "text", text: "Let me record this." },
          {
            type: "tool_use",
            id: "tu_1",
            name: "record_mastery",
            input: {
              task_statement_id: "D1.1",
              bloom_level: 1,
              outcome: "success",
            },
          },
        ]),
      )
      .mockResolvedValueOnce(
        cannedResponse("end_turn", [
          { type: "text", text: "Great — moving up to L2." },
        ]),
      );
    const res = await runTutorTurn({
      topicId: "D1.1",
      priorMessages: [],
      userMessage: "I got it right.",
      db: handle.db,
    });
    expect(res.iterationCount).toBe(2);
    expect(res.finalStopReason).toBe("end_turn");
    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls[0].name).toBe("record_mastery");
    expect(res.toolCalls[0].result).toMatchObject({ ok: true });
    // Verify the progress event was written by the handler.
    const events = handle.db
      .select()
      .from(schema.progressEvents)
      .all();
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("tutor_signal");
    // Messages: user(new), assistant(tool_use), user(tool_result), assistant(text)
    expect(res.messages).toHaveLength(4);
    expect(res.messages[1]).toMatchObject({ role: "assistant" });
    expect(res.messages[2]).toMatchObject({ role: "user" });
    const toolResultContent = res.messages[2].content;
    expect(Array.isArray(toolResultContent)).toBe(true);
    if (Array.isArray(toolResultContent)) {
      expect(toolResultContent[0]).toMatchObject({
        type: "tool_result",
        tool_use_id: "tu_1",
      });
    }
    handle.close();
  });

  it("chains multiple tool iterations before end_turn (3 iterations)", async () => {
    callClaudeMock
      .mockResolvedValueOnce(
        cannedResponse("tool_use", [
          {
            type: "tool_use",
            id: "tu_1",
            name: "lookup_bullets",
            input: { task_statement_id: "D1.1" },
          },
        ]),
      )
      .mockResolvedValueOnce(
        cannedResponse("tool_use", [
          {
            type: "tool_use",
            id: "tu_2",
            name: "record_mastery",
            input: {
              task_statement_id: "D1.1",
              bloom_level: 1,
              outcome: "success",
            },
          },
        ]),
      )
      .mockResolvedValueOnce(
        cannedResponse("end_turn", [
          { type: "text", text: "Okay, next question coming up." },
        ]),
      );
    const res = await runTutorTurn({
      topicId: "D1.1",
      priorMessages: [],
      userMessage: "start",
      db: handle.db,
    });
    expect(res.iterationCount).toBe(3);
    expect(res.toolCalls.map((c) => c.name)).toEqual([
      "lookup_bullets",
      "record_mastery",
    ]);
    expect(res.finalStopReason).toBe("end_turn");
    handle.close();
  });

  it("enforces maxIterations and marks reachedIterationCap=true", async () => {
    const infinite = () =>
      cannedResponse("tool_use", [
        {
          type: "tool_use",
          id: `tu_${Math.random()}`,
          name: "lookup_bullets",
          input: { task_statement_id: "D1.1" },
        },
      ]);
    callClaudeMock.mockImplementation(async () => infinite());

    const res = await runTutorTurn({
      topicId: "D1.1",
      priorMessages: [],
      userMessage: "keep going",
      db: handle.db,
      maxIterations: 3,
    });
    expect(res.iterationCount).toBe(3);
    expect(res.reachedIterationCap).toBe(true);
    // We issued 3 lookup_bullets calls.
    expect(res.toolCalls).toHaveLength(3);
    expect(callClaudeMock).toHaveBeenCalledTimes(3);
    handle.close();
  });

  it("returns a permission error in tool_result when the model calls an unknown tool", async () => {
    callClaudeMock
      .mockResolvedValueOnce(
        cannedResponse("tool_use", [
          {
            type: "tool_use",
            id: "tu_x",
            name: "grade_scenario", // grader-only tool; not in the tutor set
            input: { foo: "bar" },
          },
        ]),
      )
      .mockResolvedValueOnce(
        cannedResponse("end_turn", [{ type: "text", text: "Sorry." }]),
      );

    const res = await runTutorTurn({
      topicId: "D1.1",
      priorMessages: [],
      userMessage: "show me",
      db: handle.db,
    });
    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls[0].result).toMatchObject({
      isError: true,
      errorCategory: "permission",
      isRetryable: false,
    });
    handle.close();
  });

  it("surfaces a transient error when a tool handler throws", async () => {
    callClaudeMock
      .mockResolvedValueOnce(
        cannedResponse("tool_use", [
          {
            type: "tool_use",
            id: "tu_boom",
            name: "lookup_bullets",
            input: { task_statement_id: "D1.1" },
          },
        ]),
      )
      .mockResolvedValueOnce(
        cannedResponse("end_turn", [{ type: "text", text: "ok" }]),
      );

    const throwingFactory = (_db: Db) => {
      const base = buildTutorToolSet(_db);
      const override = {
        ...base.byName.get("lookup_bullets")!,
        handler: () => {
          throw new Error("simulated DB outage");
        },
      };
      const tools = [override, ...base.tools.filter((t) => t.name !== "lookup_bullets")];
      const byName = new Map(tools.map((t) => [t.name, t]));
      return { tools, byName };
    };

    const res = await runTutorTurn({
      topicId: "D1.1",
      priorMessages: [],
      userMessage: "test throw",
      db: handle.db,
      toolSetFactory: throwingFactory,
    });
    expect(res.toolCalls[0].result).toMatchObject({
      isError: true,
      errorCategory: "transient",
      isRetryable: true,
      message: expect.stringContaining("simulated DB outage"),
    });
    handle.close();
  });

  it("exits gracefully when stop_reason=tool_use but no tool_use blocks present (defensive)", async () => {
    callClaudeMock.mockResolvedValueOnce(
      cannedResponse("tool_use", [{ type: "text", text: "nothing to do" }]),
    );
    const res = await runTutorTurn({
      topicId: "D1.1",
      priorMessages: [],
      userMessage: "hi",
      db: handle.db,
    });
    expect(res.iterationCount).toBe(1);
    expect(res.toolCalls).toHaveLength(0);
    expect(res.reachedIterationCap).toBe(false);
    handle.close();
  });

  it("never parses assistant text — returns assistant-authored 'call the tool' phrase without acting on it", async () => {
    // If the loop were text-parsing, this would mis-fire. We only loop on
    // stop_reason=tool_use; stop_reason=end_turn always exits.
    callClaudeMock.mockResolvedValueOnce(
      cannedResponse("end_turn", [
        {
          type: "text",
          text: "I should call lookup_bullets on D1.1 but I won't this turn.",
        },
      ]),
    );
    const res = await runTutorTurn({
      topicId: "D1.1",
      priorMessages: [],
      userMessage: "go",
      db: handle.db,
    });
    expect(res.iterationCount).toBe(1);
    expect(res.toolCalls).toHaveLength(0);
    expect(res.finalStopReason).toBe("end_turn");
    handle.close();
  });

  it("passes tools to callClaude matching the tutor tool set shape", async () => {
    callClaudeMock.mockResolvedValueOnce(
      cannedResponse("end_turn", [{ type: "text", text: "ok" }]),
    );
    await runTutorTurn({
      topicId: "D1.1",
      priorMessages: [],
      userMessage: "hi",
      db: handle.db,
    });
    const call = callClaudeMock.mock.calls[0][0];
    expect(call.tools).toHaveLength(4);
    const names = (call.tools as Array<{ name: string }>).map((t) => t.name);
    expect(new Set(names)).toEqual(
      new Set([
        "lookup_bullets",
        "record_mastery",
        "spawn_practice_question",
        "reveal_answer",
      ]),
    );
    expect(call.role).toBe("tutor");
    expect(call.cacheSystem).toBe(true);
    // System prompt should include current case facts.
    expect(call.system).toContain("D1.1");
    expect(call.system).toContain("stop_reason semantics");
    handle.close();
  });

  it("rebuilds case facts every iteration — mid-turn events reflect in later system prompts", async () => {
    // First turn: tool_use record_mastery (creates an L1 success event).
    // Second turn: end_turn. We assert the SECOND callClaude invocation's
    // system prompt shows ceiling=0 still (1 event isn't enough — MASTERY_ITEM_FLOOR=5)
    // but reflects item progress by way of NOT crashing + showing the topic id.
    // Primary assertion: buildSystemPrompt is called per iteration (both invocations pass a system).
    callClaudeMock
      .mockResolvedValueOnce(
        cannedResponse("tool_use", [
          {
            type: "tool_use",
            id: "tu_1",
            name: "record_mastery",
            input: {
              task_statement_id: "D1.1",
              bloom_level: 1,
              outcome: "failure",
              note: "missed Q1",
            },
          },
        ]),
      )
      .mockResolvedValueOnce(
        cannedResponse("end_turn", [{ type: "text", text: "ok" }]),
      );

    await runTutorTurn({
      topicId: "D1.1",
      priorMessages: [],
      userMessage: "I got it wrong",
      db: handle.db,
    });
    expect(callClaudeMock).toHaveBeenCalledTimes(2);
    const firstSystem = callClaudeMock.mock.calls[0][0].system as string;
    const secondSystem = callClaudeMock.mock.calls[1][0].system as string;
    // First call: recent_misses is clean-slate text.
    expect(firstSystem).toContain("clean slate");
    // Second call: recent_misses now contains the failure note.
    expect(secondSystem).toContain("missed Q1");
    handle.close();
  });
});
