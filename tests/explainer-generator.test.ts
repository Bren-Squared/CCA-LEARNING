import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../lib/db";
import { schema } from "../lib/db";

// Mock the Claude client BEFORE importing the generator so the module picks
// up the mock. The mock returns a canned tool_use message; we then assert the
// second call doesn't invoke callClaude at all (AT11 caching).
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

// Dynamic import ensures the mock is in place
const { getOrGenerateExplainer } = await import("../lib/study/explainer");

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

function seedTaskStatement(db: Db): void {
  db.insert(schema.domains)
    .values({ id: "D1", title: "Domain 1", weightBps: 5000, orderIndex: 1 })
    .run();
  db.insert(schema.taskStatements)
    .values({
      id: "TS1",
      domainId: "D1",
      title: "Design agentic loops",
      knowledgeBullets: ["Stop reasons", "Tool use cycles"],
      skillsBullets: ["Choosing max iterations", "Budget guards"],
      orderIndex: 1,
    })
    .run();
}

function cannedMessage() {
  return {
    id: "msg_test",
    type: "message" as const,
    role: "assistant" as const,
    model: "claude-sonnet-4-6",
    stop_reason: "tool_use" as const,
    stop_sequence: null,
    usage: {
      input_tokens: 100,
      output_tokens: 500,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation: null,
      inference_geo: null,
      server_tool_use: null,
      service_tier: null,
    },
    content: [
      {
        type: "tool_use" as const,
        id: "tu_1",
        name: "emit_explainer",
        input: {
          narrative_md:
            "## Why agentic loops\n\nAn agentic loop is a controlled cycle where the model uses tools and decides when to stop. This narrative body is deliberately long enough to clear the 200-character minimum set by the tool schema, and it talks about stop_reason handling.",
          check_questions: [
            {
              stem: "Which stop_reason signals tool execution?",
              options: ["end_turn", "tool_use", "max_tokens", "pause_turn"],
              correct_index: 1,
              explanation:
                "tool_use means the model emitted a tool call. end_turn is a normal completion; max_tokens means truncated; pause_turn is streaming-only.",
              bloom_level: 2,
              bloom_justification:
                "Recall + recognition of the SDK's stop_reason taxonomy.",
            },
            {
              stem: "When would you add a budget guard?",
              options: [
                "After first tool call",
                "Never",
                "Before every loop iteration",
                "Only in production",
              ],
              correct_index: 2,
              explanation:
                "Checking before every iteration catches runaway loops early. A is too late; B is reckless; D ignores dev loops.",
              bloom_level: 3,
              bloom_justification:
                "Applies the budget-guard pattern to a new situation.",
            },
          ],
        },
      },
    ],
  };
}

describe("getOrGenerateExplainer", () => {
  let handle: ReturnType<typeof freshDb>;

  beforeEach(() => {
    handle = freshDb();
    seedTaskStatement(handle.db);
    callClaudeMock.mockReset();
    callClaudeMock.mockResolvedValue(cannedMessage());
  });

  it("calls Claude on first invocation and persists narrative + questions", async () => {
    const artifact = await getOrGenerateExplainer("TS1", { db: handle.db });

    expect(callClaudeMock).toHaveBeenCalledTimes(1);
    expect(artifact.cached).toBe(false);
    expect(artifact.narrativeMd).toMatch(/agentic loops/);
    expect(artifact.checkQuestions).toHaveLength(2);

    const row = handle.db
      .select()
      .from(schema.taskStatements)
      .where(eq(schema.taskStatements.id, "TS1"))
      .get();
    expect(row?.narrativeMd).toMatch(/agentic loops/);
    expect(row?.narrativeGeneratedAt).toBeDefined();

    const questions = handle.db
      .select()
      .from(schema.questions)
      .where(eq(schema.questions.taskStatementId, "TS1"))
      .all();
    expect(questions).toHaveLength(2);
    expect(questions[0].source).toBe("generated");
    handle.close();
  });

  it("serves cached artifact on second call without invoking Claude (AT11)", async () => {
    await getOrGenerateExplainer("TS1", { db: handle.db });
    expect(callClaudeMock).toHaveBeenCalledTimes(1);

    const second = await getOrGenerateExplainer("TS1", { db: handle.db });
    expect(callClaudeMock).toHaveBeenCalledTimes(1); // unchanged
    expect(second.cached).toBe(true);
    expect(second.narrativeMd).toMatch(/agentic loops/);
    expect(second.checkQuestions).toHaveLength(2);
    handle.close();
  });

  it("regenerates when forceRegenerate=true", async () => {
    await getOrGenerateExplainer("TS1", { db: handle.db });
    await getOrGenerateExplainer("TS1", {
      db: handle.db,
      forceRegenerate: true,
    });
    expect(callClaudeMock).toHaveBeenCalledTimes(2);
    handle.close();
  });

  it("throws ExplainerError with code=not_found on bad task statement id", async () => {
    await expect(
      getOrGenerateExplainer("TS_NOPE", { db: handle.db }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(callClaudeMock).not.toHaveBeenCalled();
    handle.close();
  });

  it("throws ExplainerError when model returns invalid tool output", async () => {
    callClaudeMock.mockResolvedValueOnce({
      ...cannedMessage(),
      content: [
        {
          type: "tool_use",
          id: "tu_bad",
          name: "emit_explainer",
          input: { narrative_md: "too short", check_questions: [] },
        },
      ],
    });
    await expect(
      getOrGenerateExplainer("TS1", { db: handle.db }),
    ).rejects.toMatchObject({ code: "bad_tool_output" });
    handle.close();
  });

  it("throws ExplainerError when model returns no tool_use block", async () => {
    callClaudeMock.mockResolvedValueOnce({
      ...cannedMessage(),
      stop_reason: "end_turn",
      content: [{ type: "text", text: "I refuse to use the tool." }],
    });
    await expect(
      getOrGenerateExplainer("TS1", { db: handle.db }),
    ).rejects.toMatchObject({ code: "no_tool_use" });
    handle.close();
  });
});
