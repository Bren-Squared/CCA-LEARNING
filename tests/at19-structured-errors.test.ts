import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../lib/db";
import { schema } from "../lib/db";
import { toolErrorSchema } from "../lib/claude/tools";

/**
 * AT19 end-to-end proof — the tutor agentic loop translates every tool-side
 * failure mode into the structured error shape (FR3.5 / D2.2) before the
 * model sees it, across ALL four categories in a single arc:
 *
 *   - validation (zod rejects the model's input)
 *   - business   (handler returns a toolError for a real "no")
 *   - permission (model calls a tool not in its set)
 *   - transient  (handler throws — wrapped as retryable)
 *
 * The earlier tool-errors.test.ts asserts the SHAPE of the error API; this
 * file asserts the WIRING — that the serialized bytes the model receives in
 * tool_result content are valid JSON matching toolErrorSchema, with the
 * expected errorCategory / isRetryable.
 */

const callClaudeMock = vi.fn();
vi.mock("../lib/claude/client", async () => {
  const actual = await vi.importActual<typeof import("../lib/claude/client")>(
    "../lib/claude/client",
  );
  return { ...actual, callClaude: callClaudeMock };
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
      title: "Agentic loops",
      knowledgeBullets: ["stop_reason semantics"],
      skillsBullets: ["max-iteration guard"],
      orderIndex: 1,
    })
    .run();
}

function cannedToolUse(id: string, name: string, input: Record<string, unknown>) {
  return {
    id: "msg_test",
    type: "message" as const,
    role: "assistant" as const,
    model: "claude-sonnet-4-6",
    stop_reason: "tool_use" as const,
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
    content: [{ type: "tool_use" as const, id, name, input }],
  };
}

function cannedEndTurn(text: string) {
  return {
    id: "msg_done",
    type: "message" as const,
    role: "assistant" as const,
    model: "claude-sonnet-4-6",
    stop_reason: "end_turn" as const,
    stop_sequence: null,
    usage: {
      input_tokens: 20,
      output_tokens: 30,
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

/**
 * Extract the ONLY tool_result block from the transcript. We assert both the
 * record-level audit entry and the bytes the model saw — those are the two
 * sides of the D2.2 contract.
 */
function onlyToolResult(
  messages: Awaited<ReturnType<typeof runTutorTurn>>["messages"],
): { is_error: boolean | undefined; content: string } {
  for (const m of messages) {
    if (m.role !== "user" || typeof m.content === "string") continue;
    for (const block of m.content) {
      if ((block as { type: string }).type === "tool_result") {
        const b = block as {
          type: "tool_result";
          is_error?: boolean;
          content?: string;
        };
        return { is_error: b.is_error, content: b.content ?? "" };
      }
    }
  }
  throw new Error("no tool_result block found in transcript");
}

describe("AT19 — every tool error category surfaces the D2.2 structured shape", () => {
  let handle: ReturnType<typeof freshDb>;

  beforeEach(() => {
    handle = freshDb();
    seedTs(handle.db);
    callClaudeMock.mockReset();
  });

  it("validation: zod rejects the model's argument shape", async () => {
    callClaudeMock
      .mockResolvedValueOnce(
        cannedToolUse("tu_v", "lookup_bullets", {
          task_statement_id: 42, // zod expects a string
        }),
      )
      .mockResolvedValueOnce(cannedEndTurn("fixing"));

    const res = await runTutorTurn({
      topicId: "D1.1",
      priorMessages: [],
      userMessage: "lookup",
      db: handle.db,
    });

    expect(res.toolCalls).toHaveLength(1);
    // Validation errors are retryable per the tutor tool set's policy — the
    // model can fix the input and try again. D2.2 schema only mandates the
    // shape, not a specific retry default, so we assert category only.
    expect(res.toolCalls[0].result).toMatchObject({
      isError: true,
      errorCategory: "validation",
    });
    const tr = onlyToolResult(res.messages);
    expect(tr.is_error).toBe(true);
    const parsed = toolErrorSchema.safeParse(JSON.parse(tr.content));
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.errorCategory).toBe("validation");
    handle.close();
  });

  it("business: handler returns toolError for a real no (unknown task_statement_id)", async () => {
    callClaudeMock
      .mockResolvedValueOnce(
        cannedToolUse("tu_b", "lookup_bullets", {
          task_statement_id: "D9.9", // passes zod, fails the business rule
        }),
      )
      .mockResolvedValueOnce(cannedEndTurn("oh"));

    const res = await runTutorTurn({
      topicId: "D1.1",
      priorMessages: [],
      userMessage: "lookup ghost",
      db: handle.db,
    });

    expect(res.toolCalls[0].result).toMatchObject({
      isError: true,
      errorCategory: "business",
      isRetryable: false,
    });
    const tr = onlyToolResult(res.messages);
    expect(tr.is_error).toBe(true);
    const parsed = toolErrorSchema.safeParse(JSON.parse(tr.content));
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.errorCategory).toBe("business");
    handle.close();
  });

  it("permission: model calls a tool outside its narrow set (D2.3)", async () => {
    callClaudeMock
      .mockResolvedValueOnce(
        cannedToolUse("tu_p", "record_grade", { anything: 1 }),
      )
      .mockResolvedValueOnce(cannedEndTurn("noted"));

    const res = await runTutorTurn({
      topicId: "D1.1",
      priorMessages: [],
      userMessage: "try grader tool",
      db: handle.db,
    });

    expect(res.toolCalls[0].result).toMatchObject({
      isError: true,
      errorCategory: "permission",
      isRetryable: false,
    });
    const tr = onlyToolResult(res.messages);
    expect(tr.is_error).toBe(true);
    const parsed = toolErrorSchema.safeParse(JSON.parse(tr.content));
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.errorCategory).toBe("permission");
    handle.close();
  });

  it("transient: handler throws — wrapped as retryable transient", async () => {
    callClaudeMock
      .mockResolvedValueOnce(
        cannedToolUse("tu_t", "lookup_bullets", { task_statement_id: "D1.1" }),
      )
      .mockResolvedValueOnce(cannedEndTurn("retrying later"));

    const throwingFactory = (db: Db) => {
      const base = buildTutorToolSet(db);
      const override = {
        ...base.byName.get("lookup_bullets")!,
        handler: () => {
          throw new Error("upstream 503");
        },
      };
      const tools = [
        override,
        ...base.tools.filter((t) => t.name !== "lookup_bullets"),
      ];
      const byName = new Map(tools.map((t) => [t.name, t]));
      return { tools, byName };
    };

    const res = await runTutorTurn({
      topicId: "D1.1",
      priorMessages: [],
      userMessage: "flaky call",
      db: handle.db,
      toolSetFactory: throwingFactory,
    });

    expect(res.toolCalls[0].result).toMatchObject({
      isError: true,
      errorCategory: "transient",
      isRetryable: true,
    });
    const tr = onlyToolResult(res.messages);
    expect(tr.is_error).toBe(true);
    const parsed = toolErrorSchema.safeParse(JSON.parse(tr.content));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.errorCategory).toBe("transient");
      expect(parsed.data.isRetryable).toBe(true);
      expect(parsed.data.message).toContain("upstream 503");
    }
    handle.close();
  });

  it("loop survives every category and terminates with end_turn (no wedge)", async () => {
    // Model tries business → permission → validation → transient → gives up,
    // all in one turn's tool-use cycles. The loop must record all four with
    // the correct category and terminate when the final response is end_turn.
    callClaudeMock
      .mockResolvedValueOnce(
        cannedToolUse("tu_1", "lookup_bullets", { task_statement_id: "D9.9" }),
      )
      .mockResolvedValueOnce(
        cannedToolUse("tu_2", "record_grade", { x: 1 }),
      )
      .mockResolvedValueOnce(
        cannedToolUse("tu_3", "lookup_bullets", { task_statement_id: 99 }),
      )
      .mockResolvedValueOnce(
        cannedToolUse("tu_4", "lookup_bullets", { task_statement_id: "D1.1" }),
      )
      .mockResolvedValueOnce(
        cannedEndTurn("I hit four failures and I'm handing back."),
      );

    const throwOnD11 = (db: Db) => {
      const base = buildTutorToolSet(db);
      const override = {
        ...base.byName.get("lookup_bullets")!,
        handler: (input: { task_statement_id: string }) => {
          if (input.task_statement_id === "D1.1") {
            throw new Error("simulated 503");
          }
          return base.byName.get("lookup_bullets")!.handler(input);
        },
      };
      const tools = [
        override,
        ...base.tools.filter((t) => t.name !== "lookup_bullets"),
      ];
      return { tools, byName: new Map(tools.map((t) => [t.name, t])) };
    };

    const res = await runTutorTurn({
      topicId: "D1.1",
      priorMessages: [],
      userMessage: "try every failure",
      db: handle.db,
      toolSetFactory: throwOnD11,
    });

    expect(res.finalStopReason).toBe("end_turn");
    expect(res.reachedIterationCap).toBe(false);
    expect(res.toolCalls).toHaveLength(4);
    const categories = res.toolCalls.map((c) =>
      "errorCategory" in c.result ? c.result.errorCategory : "ok",
    );
    expect(categories).toEqual([
      "business",
      "permission",
      "validation",
      "transient",
    ]);
    // Every audit record matches the shared schema so UIs / logs can uniformly
    // render and filter AT19 errors.
    for (const call of res.toolCalls) {
      if ("errorCategory" in call.result) {
        expect(
          toolErrorSchema.safeParse(call.result).success,
        ).toBe(true);
      }
    }
    handle.close();
  });
});
