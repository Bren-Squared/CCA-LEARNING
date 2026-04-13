import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../lib/db";
import { schema } from "../lib/db";

// Mock Claude client BEFORE importing the generator so the module picks up
// the mock. We drive per-role responses by inspecting params.role on each
// call, and assert the reviewer never sees generator scratchpad (D4.6).
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

const { generateOneQuestion, GeneratorError, MAX_GENERATION_ATTEMPTS } = await import(
  "../lib/study/generator"
);

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

function goodQuestion() {
  return {
    stem: "Which stop_reason signals tool execution in the SDK?",
    options: ["end_turn", "tool_use", "max_tokens", "pause_turn"],
    correct_index: 1,
    explanations: [
      "end_turn indicates a normal completion, not a tool call.",
      "tool_use means the model emitted a tool call.",
      "max_tokens signals truncation, not a tool call.",
      "pause_turn is a streaming pause, not a tool-call signal.",
    ],
    bloom_level: 2,
    bloom_justification: "Recognition of the SDK's stop_reason taxonomy.",
    difficulty: 2,
  };
}

function questionMessage(input: unknown) {
  return {
    id: "msg_gen",
    type: "message" as const,
    role: "assistant" as const,
    model: "claude-sonnet-4-6",
    stop_reason: "tool_use" as const,
    stop_sequence: null,
    usage: {
      input_tokens: 100,
      output_tokens: 400,
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
        id: "tu_q",
        name: "emit_question",
        input,
      },
    ],
  };
}

function reviewMessage(input: unknown) {
  return {
    id: "msg_rev",
    type: "message" as const,
    role: "assistant" as const,
    model: "claude-haiku-4-5-20251001",
    stop_reason: "tool_use" as const,
    stop_sequence: null,
    usage: {
      input_tokens: 80,
      output_tokens: 120,
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
        id: "tu_r",
        name: "emit_review",
        input,
      },
    ],
  };
}

describe("generateOneQuestion", () => {
  let handle: ReturnType<typeof freshDb>;

  beforeEach(() => {
    handle = freshDb();
    seedTaskStatement(handle.db);
    callClaudeMock.mockReset();
  });

  it("persists an approved question on the first attempt (happy path)", async () => {
    callClaudeMock.mockImplementation(async (params: { role: string }) => {
      if (params.role === "generator") return questionMessage(goodQuestion());
      return reviewMessage({
        verdict: "approve",
        summary: "Key is unambiguous; distractors are plausible.",
      });
    });

    const result = await generateOneQuestion({
      taskStatementId: "TS1",
      bloomLevel: 2,
      db: handle.db,
    });

    expect(result.attemptsUsed).toBe(1);
    expect(callClaudeMock).toHaveBeenCalledTimes(2); // generator + reviewer

    const row = handle.db
      .select()
      .from(schema.questions)
      .where(eq(schema.questions.id, result.questionId))
      .get();
    expect(row).toBeDefined();
    expect(row?.source).toBe("generated");
    expect(row?.status).toBe("active");
    expect(row?.taskStatementId).toBe("TS1");
    expect(row?.bloomLevel).toBe(2);
    handle.close();
  });

  it("retries on reviewer reject and persists on the second attempt (AT12)", async () => {
    let callIdx = 0;
    callClaudeMock.mockImplementation(async (params: { role: string }) => {
      callIdx++;
      if (params.role === "generator") return questionMessage(goodQuestion());
      // First review rejects, second approves
      if (callIdx === 2) {
        return reviewMessage({
          verdict: "reject",
          summary: "Distractor B is out of domain.",
          violations: [
            {
              code: "implausible_distractor",
              detail: "Option D references pause_turn which is not in the bullets.",
            },
          ],
          suggestions: ["Replace D with 'refusal' to keep it in-domain."],
        });
      }
      return reviewMessage({
        verdict: "approve",
        summary: "Retry addressed the out-of-domain distractor.",
      });
    });

    const result = await generateOneQuestion({
      taskStatementId: "TS1",
      bloomLevel: 2,
      db: handle.db,
    });

    expect(result.attemptsUsed).toBe(2);
    expect(callClaudeMock).toHaveBeenCalledTimes(4);

    const inserted = handle.db
      .select()
      .from(schema.questions)
      .where(eq(schema.questions.taskStatementId, "TS1"))
      .all();
    expect(inserted).toHaveLength(1);
    expect(inserted[0].source).toBe("generated");
    handle.close();
  });

  it("throws GeneratorError(exhausted) after max rejections without persisting", async () => {
    callClaudeMock.mockImplementation(async (params: { role: string }) => {
      if (params.role === "generator") return questionMessage(goodQuestion());
      return reviewMessage({
        verdict: "reject",
        summary: "Key is ambiguous.",
        violations: [
          { code: "ambiguous_stem", detail: "Options A and B are both correct." },
        ],
      });
    });

    await expect(
      generateOneQuestion({
        taskStatementId: "TS1",
        bloomLevel: 2,
        db: handle.db,
      }),
    ).rejects.toMatchObject({ code: "exhausted" });

    expect(callClaudeMock).toHaveBeenCalledTimes(MAX_GENERATION_ATTEMPTS * 2);
    const inserted = handle.db
      .select()
      .from(schema.questions)
      .where(eq(schema.questions.taskStatementId, "TS1"))
      .all();
    expect(inserted).toHaveLength(0);
    handle.close();
  });

  it("threads reviewer feedback into the generator's system prompt on retry", async () => {
    const systemPrompts: string[] = [];
    let gcalls = 0;
    callClaudeMock.mockImplementation(
      async (params: { role: string; system: unknown }) => {
        if (params.role === "generator") {
          gcalls++;
          const text = Array.isArray(params.system)
            ? (params.system as { text?: string }[]).map((b) => b.text ?? "").join("\n")
            : String(params.system ?? "");
          systemPrompts.push(text);
          return questionMessage(goodQuestion());
        }
        if (gcalls === 1) {
          return reviewMessage({
            verdict: "reject",
            summary: "Distractor problem.",
            violations: [
              {
                code: "implausible_distractor",
                detail: "Distractor references a feature not in the bullets.",
              },
            ],
          });
        }
        return reviewMessage({
          verdict: "approve",
          summary: "Fixed on retry.",
        });
      },
    );

    await generateOneQuestion({
      taskStatementId: "TS1",
      bloomLevel: 2,
      db: handle.db,
    });

    expect(systemPrompts[0]).not.toMatch(/Reviewer rejected your previous attempt/);
    expect(systemPrompts[1]).toMatch(/Reviewer rejected your previous attempt/);
    expect(systemPrompts[1]).toMatch(/implausible_distractor/);
    handle.close();
  });

  it("throws GeneratorError(not_found) on bad task statement id", async () => {
    await expect(
      generateOneQuestion({
        taskStatementId: "NOPE",
        bloomLevel: 2,
        db: handle.db,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(callClaudeMock).not.toHaveBeenCalled();
    handle.close();
  });

  it("throws GeneratorError(bad_generator_output) on malformed emit_question", async () => {
    callClaudeMock.mockImplementation(async () =>
      questionMessage({ stem: "too short" }),
    );
    await expect(
      generateOneQuestion({
        taskStatementId: "TS1",
        bloomLevel: 2,
        db: handle.db,
      }),
    ).rejects.toBeInstanceOf(GeneratorError);
    await expect(
      generateOneQuestion({
        taskStatementId: "TS1",
        bloomLevel: 2,
        db: handle.db,
      }),
    ).rejects.toMatchObject({ code: "bad_generator_output" });
    handle.close();
  });

  it("routes reviewer call to the cheap model tier", async () => {
    const models: Array<{ role: string; model?: string }> = [];
    callClaudeMock.mockImplementation(
      async (params: { role: string; model?: string }) => {
        models.push({ role: params.role, model: params.model });
        if (params.role === "generator") return questionMessage(goodQuestion());
        return reviewMessage({
          verdict: "approve",
          summary: "all criteria pass",
        });
      },
    );

    await generateOneQuestion({
      taskStatementId: "TS1",
      bloomLevel: 2,
      db: handle.db,
    });

    const reviewer = models.find((m) => m.role === "reviewer");
    expect(reviewer?.model).toBeDefined();
    // Default cheap model seed is haiku per settings bootstrap
    expect(reviewer?.model).toMatch(/haiku/i);
    handle.close();
  });
});
