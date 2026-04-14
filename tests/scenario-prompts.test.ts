import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
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
  createScenarioPrompt,
  getOrGenerateRubric,
  getScenarioPrompt,
  listPromptsForScenario,
  listAllScenariosWithPrompts,
  readRubricCache,
  upsertScenarioPromptByOrder,
} = await import("../lib/scenarios/prompts");

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

function seedCurriculum(db: Db): void {
  db.insert(schema.domains)
    .values({ id: "D5", title: "Domain 5", weightBps: 1500, orderIndex: 5 })
    .run();
  db.insert(schema.taskStatements)
    .values({
      id: "D5.2",
      domainId: "D5",
      title: "Design effective escalation and ambiguity resolution patterns",
      knowledgeBullets: [
        "Triggers for handing control to a human",
        "Information the agent must preserve on escalation",
      ],
      skillsBullets: [
        "Write explicit escalation rules that cite named triggers",
        "Distinguish clarify-then-retry from escalate",
      ],
      orderIndex: 2,
    })
    .run();
  db.insert(schema.scenarios)
    .values({
      id: "S1",
      title: "Customer Support Resolution Agent",
      description:
        "You are building a customer support resolution agent using the Claude Agent SDK with custom MCP tools and an escalate_to_human option.",
      orderIndex: 0,
    })
    .run();
}

function cannedRubricMessage() {
  return {
    id: "msg_rubric",
    type: "message" as const,
    role: "assistant" as const,
    model: "claude-sonnet-4-6",
    stop_reason: "tool_use" as const,
    stop_sequence: null,
    usage: {
      input_tokens: 300,
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
        id: "tu_rubric",
        name: "emit_rubric",
        input: {
          criteria: [
            {
              id: "escalation_triggers",
              title: "Lists distinct escalation triggers",
              description:
                "The answer must name the specific signals that move the decision to escalate rather than clarify or self-serve.",
              weight: 0.5,
              score_anchors: {
                "0": "No escalation triggers named at all.",
                "3": "Names one trigger but does not distinguish it from clarify-then-retry.",
                "5": "Names three distinct triggers and explains how each differs from clarify-then-retry.",
              },
            },
            {
              id: "handoff_payload",
              title: "Describes handoff information to the human",
              description:
                "The answer must specify what context the agent attaches when calling escalate_to_human.",
              weight: 0.3,
              score_anchors: {
                "0": "No mention of what the human receives.",
                "3": "Names the fact of a handoff but not the payload.",
                "5": "Enumerates the specific fields: customer, order, tool history, and the policy trigger that fired.",
              },
            },
            {
              id: "over_escalation_guard",
              title: "Prevents over-escalating low-ambiguity cases",
              description:
                "The answer must address why the policy stays quiet when a case is clearly self-servable.",
              weight: 0.2,
              score_anchors: {
                "0": "No discussion of when NOT to escalate.",
                "3": "Notes that over-escalation is bad but no mechanism.",
                "5": "Names a concrete gate: ambiguity is measured, and escalation requires one trigger above threshold.",
              },
            },
          ],
        },
      },
    ],
  };
}

describe("scenario prompt catalog", () => {
  let handle: ReturnType<typeof freshDb>;

  beforeEach(() => {
    handle = freshDb();
    seedCurriculum(handle.db);
    callClaudeMock.mockReset();
  });

  it("createScenarioPrompt inserts a row with rubric=null initially", () => {
    const id = createScenarioPrompt(
      {
        scenarioId: "S1",
        taskStatementId: "D5.2",
        bloomLevel: 4,
        promptText:
          "Design the escalation policy for when the agent should call escalate_to_human.",
        orderIndex: 0,
      },
      handle.db,
    );
    const row = handle.db
      .select()
      .from(schema.scenarioPrompts)
      .where(eq(schema.scenarioPrompts.id, id))
      .get();
    expect(row).toBeDefined();
    expect(row?.rubric).toBeNull();
    expect(row?.rubricGeneratedAt).toBeNull();
    handle.close();
  });

  it("getScenarioPrompt returns a summary with hasRubric=false until generated", () => {
    const id = createScenarioPrompt(
      {
        scenarioId: "S1",
        taskStatementId: "D5.2",
        bloomLevel: 4,
        promptText: "Design the escalation policy.",
        orderIndex: 0,
      },
      handle.db,
    );
    const summary = getScenarioPrompt(id, handle.db);
    expect(summary).not.toBeNull();
    expect(summary?.scenarioTitle).toBe("Customer Support Resolution Agent");
    expect(summary?.taskStatementTitle).toMatch(/escalation/i);
    expect(summary?.hasRubric).toBe(false);
    handle.close();
  });

  it("listPromptsForScenario orders by orderIndex", () => {
    const second = createScenarioPrompt(
      {
        scenarioId: "S1",
        taskStatementId: "D5.2",
        bloomLevel: 4,
        promptText: "Second prompt.",
        orderIndex: 1,
      },
      handle.db,
    );
    const first = createScenarioPrompt(
      {
        scenarioId: "S1",
        taskStatementId: "D5.2",
        bloomLevel: 3,
        promptText: "First prompt.",
        orderIndex: 0,
      },
      handle.db,
    );
    const rows = listPromptsForScenario("S1", handle.db);
    expect(rows.map((r) => r.id)).toEqual([first, second]);
    handle.close();
  });

  it("listAllScenariosWithPrompts groups prompts under their scenario", () => {
    createScenarioPrompt(
      {
        scenarioId: "S1",
        taskStatementId: "D5.2",
        bloomLevel: 4,
        promptText: "First.",
        orderIndex: 0,
      },
      handle.db,
    );
    const all = listAllScenariosWithPrompts(handle.db);
    expect(all).toHaveLength(1);
    expect(all[0].scenarioId).toBe("S1");
    expect(all[0].prompts).toHaveLength(1);
    handle.close();
  });

  it("upsertScenarioPromptByOrder is idempotent by (scenarioId, orderIndex)", () => {
    const { id: firstId, created: firstCreated } = upsertScenarioPromptByOrder(
      {
        scenarioId: "S1",
        taskStatementId: "D5.2",
        bloomLevel: 4,
        promptText: "Version 1.",
        orderIndex: 0,
      },
      handle.db,
    );
    expect(firstCreated).toBe(true);

    const { id: secondId, created: secondCreated } = upsertScenarioPromptByOrder(
      {
        scenarioId: "S1",
        taskStatementId: "D5.2",
        bloomLevel: 4,
        promptText: "Version 1.",
        orderIndex: 0,
      },
      handle.db,
    );
    expect(secondCreated).toBe(false);
    expect(secondId).toBe(firstId);

    const rows = handle.db
      .select()
      .from(schema.scenarioPrompts)
      .all();
    expect(rows).toHaveLength(1);
    handle.close();
  });

  it("upsert invalidates the rubric when prompt text changes", () => {
    const { id } = upsertScenarioPromptByOrder(
      {
        scenarioId: "S1",
        taskStatementId: "D5.2",
        bloomLevel: 4,
        promptText: "Original prompt.",
        orderIndex: 0,
      },
      handle.db,
    );
    handle.db
      .update(schema.scenarioPrompts)
      .set({
        rubric: { criteria: [{ id: "fake" }] },
        rubricGeneratedAt: new Date(),
      })
      .where(eq(schema.scenarioPrompts.id, id))
      .run();

    upsertScenarioPromptByOrder(
      {
        scenarioId: "S1",
        taskStatementId: "D5.2",
        bloomLevel: 4,
        promptText: "Rewritten prompt.",
        orderIndex: 0,
      },
      handle.db,
    );

    const row = handle.db
      .select()
      .from(schema.scenarioPrompts)
      .where(eq(schema.scenarioPrompts.id, id))
      .get();
    expect(row?.rubric).toBeNull();
    expect(row?.rubricGeneratedAt).toBeNull();
    expect(row?.promptText).toBe("Rewritten prompt.");
    handle.close();
  });

  it("upsert preserves rubric when prompt text is unchanged", () => {
    const { id } = upsertScenarioPromptByOrder(
      {
        scenarioId: "S1",
        taskStatementId: "D5.2",
        bloomLevel: 4,
        promptText: "Stable prompt.",
        orderIndex: 0,
      },
      handle.db,
    );
    const now = new Date();
    handle.db
      .update(schema.scenarioPrompts)
      .set({
        rubric: { criteria: [{ id: "fake" }] },
        rubricGeneratedAt: now,
      })
      .where(eq(schema.scenarioPrompts.id, id))
      .run();

    upsertScenarioPromptByOrder(
      {
        scenarioId: "S1",
        taskStatementId: "D5.2",
        bloomLevel: 4,
        promptText: "Stable prompt.",
        orderIndex: 0,
      },
      handle.db,
    );

    const row = handle.db
      .select()
      .from(schema.scenarioPrompts)
      .where(eq(schema.scenarioPrompts.id, id))
      .get();
    expect(row?.rubric).not.toBeNull();
    expect(row?.rubricGeneratedAt?.getTime()).toBe(now.getTime());
    handle.close();
  });
});

describe("getOrGenerateRubric (RD4 lazy generation)", () => {
  let handle: ReturnType<typeof freshDb>;
  let promptId: string;

  beforeEach(() => {
    handle = freshDb();
    seedCurriculum(handle.db);
    promptId = createScenarioPrompt(
      {
        scenarioId: "S1",
        taskStatementId: "D5.2",
        bloomLevel: 4,
        promptText:
          "Design the escalation policy deciding when the agent escalates vs clarifies vs self-serves.",
        orderIndex: 0,
      },
      handle.db,
    );
    callClaudeMock.mockReset();
    callClaudeMock.mockResolvedValue(cannedRubricMessage());
  });

  it("calls rubric-drafter once on first request and persists the rubric", async () => {
    const result = await getOrGenerateRubric(promptId, { db: handle.db });
    expect(callClaudeMock).toHaveBeenCalledTimes(1);
    expect(result.cached).toBe(false);
    expect(result.rubric.criteria).toHaveLength(3);

    const sumWeights = result.rubric.criteria.reduce((a, c) => a + c.weight, 0);
    expect(sumWeights).toBeCloseTo(1.0, 6);

    const row = handle.db
      .select()
      .from(schema.scenarioPrompts)
      .where(eq(schema.scenarioPrompts.id, promptId))
      .get();
    expect(row?.rubric).toBeDefined();
    expect(row?.rubricGeneratedAt).toBeInstanceOf(Date);
    handle.close();
  });

  it("serves the cached rubric on the second call — zero additional Claude calls (RD4)", async () => {
    await getOrGenerateRubric(promptId, { db: handle.db });
    const second = await getOrGenerateRubric(promptId, { db: handle.db });
    expect(callClaudeMock).toHaveBeenCalledTimes(1);
    expect(second.cached).toBe(true);
    expect(second.rubric.criteria).toHaveLength(3);
    handle.close();
  });

  it("forceRegenerate=true re-calls Claude and overwrites the stored rubric", async () => {
    const first = await getOrGenerateRubric(promptId, { db: handle.db });
    const second = await getOrGenerateRubric(promptId, {
      db: handle.db,
      forceRegenerate: true,
    });
    expect(callClaudeMock).toHaveBeenCalledTimes(2);
    expect(second.cached).toBe(false);
    expect(second.generatedAt.getTime()).toBeGreaterThanOrEqual(
      first.generatedAt.getTime(),
    );
    handle.close();
  });

  it("throws not_found on an unknown prompt id", async () => {
    await expect(
      getOrGenerateRubric("nope", { db: handle.db }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(callClaudeMock).not.toHaveBeenCalled();
    handle.close();
  });

  it("throws no_tool_use when the model skipped emit_rubric", async () => {
    callClaudeMock.mockResolvedValueOnce({
      ...cannedRubricMessage(),
      content: [{ type: "text" as const, text: "Sorry, can't help." }],
      stop_reason: "end_turn",
    });
    await expect(
      getOrGenerateRubric(promptId, { db: handle.db }),
    ).rejects.toMatchObject({ code: "no_tool_use" });
    handle.close();
  });

  it("throws bad_tool_output when emit_rubric weights don't sum to 1.0", async () => {
    callClaudeMock.mockResolvedValueOnce({
      ...cannedRubricMessage(),
      content: [
        {
          type: "tool_use" as const,
          id: "tu_bad",
          name: "emit_rubric",
          input: {
            criteria: [
              {
                id: "a",
                title: "Criterion A",
                description: "A criterion that is described long enough.",
                weight: 0.4,
                score_anchors: {
                  "0": "zero anchor text",
                  "3": "three anchor text",
                  "5": "five anchor text",
                },
              },
              {
                id: "b",
                title: "Criterion B",
                description: "A criterion that is described long enough.",
                weight: 0.4,
                score_anchors: {
                  "0": "zero anchor text",
                  "3": "three anchor text",
                  "5": "five anchor text",
                },
              },
              {
                id: "c",
                title: "Criterion C",
                description: "A criterion that is described long enough.",
                weight: 0.1,
                score_anchors: {
                  "0": "zero anchor text",
                  "3": "three anchor text",
                  "5": "five anchor text",
                },
              },
            ],
          },
        },
      ],
    });
    await expect(
      getOrGenerateRubric(promptId, { db: handle.db }),
    ).rejects.toMatchObject({ code: "bad_tool_output" });
    handle.close();
  });
});

describe("readRubricCache", () => {
  let handle: ReturnType<typeof freshDb>;

  beforeEach(() => {
    handle = freshDb();
    seedCurriculum(handle.db);
    callClaudeMock.mockReset();
    callClaudeMock.mockResolvedValue(cannedRubricMessage());
  });

  it("returns null before the rubric has been generated", () => {
    const id = createScenarioPrompt(
      {
        scenarioId: "S1",
        taskStatementId: "D5.2",
        bloomLevel: 4,
        promptText: "Prompt.",
        orderIndex: 0,
      },
      handle.db,
    );
    expect(readRubricCache(id, handle.db)).toBeNull();
    handle.close();
  });

  it("returns the stored rubric once generated — does not call Claude", async () => {
    const id = createScenarioPrompt(
      {
        scenarioId: "S1",
        taskStatementId: "D5.2",
        bloomLevel: 4,
        promptText: "Prompt.",
        orderIndex: 0,
      },
      handle.db,
    );
    await getOrGenerateRubric(id, { db: handle.db });
    callClaudeMock.mockReset();
    const cached = readRubricCache(id, handle.db);
    expect(cached).not.toBeNull();
    expect(callClaudeMock).not.toHaveBeenCalled();
    expect(cached?.rubric.criteria).toHaveLength(3);
    handle.close();
  });
});
