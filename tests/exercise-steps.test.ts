import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { randomUUID } from "node:crypto";
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
  ExerciseError,
  getExercise,
  getOrGenerateStepRubric,
  getStep,
  listExercises,
  readStepRubricCache,
  resolveReinforcedTaskStatements,
  loadPriorStepArtifacts,
} = await import("../lib/exercises/steps");

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
    .values({ id: "D1", title: "Domain 1", weightBps: 2700, orderIndex: 1 })
    .run();
  db.insert(schema.domains)
    .values({ id: "D4", title: "Domain 4", weightBps: 2000, orderIndex: 4 })
    .run();
  db.insert(schema.taskStatements)
    .values([
      {
        id: "D1.1",
        domainId: "D1",
        title: "Agentic loops",
        knowledgeBullets: ["stop_reason semantics"],
        skillsBullets: ["Inspect stop_reason and branch control flow"],
        orderIndex: 1,
      },
      {
        id: "D1.2",
        domainId: "D1",
        title: "Tool design",
        knowledgeBullets: ["Tool description differentiation"],
        skillsBullets: ["Write non-overlapping tool descriptions"],
        orderIndex: 2,
      },
      {
        id: "D4.1",
        domainId: "D4",
        title: "Prompt construction",
        knowledgeBullets: ["Explicit criteria beat hedging"],
        skillsBullets: ["Write concrete criteria"],
        orderIndex: 1,
      },
    ])
    .run();
  db.insert(schema.preparationExercises)
    .values({
      id: "EX1",
      title: "Build a Multi-Tool Agent",
      description: "Practice designing an agentic loop with tools.",
      domainsReinforced: ["D1"],
      orderIndex: 0,
    })
    .run();
  db.insert(schema.preparationSteps)
    .values([
      {
        id: "EX1-S0",
        exerciseId: "EX1",
        stepIdx: 0,
        prompt: "Define 3-4 MCP tools with distinct descriptions.",
      },
      {
        id: "EX1-S1",
        exerciseId: "EX1",
        stepIdx: 1,
        prompt: "Implement the agentic loop.",
      },
    ])
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
      input_tokens: 400,
      output_tokens: 600,
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
              id: "tool_differentiation",
              title: "Tools have distinct, bounded descriptions",
              description:
                "Each tool's description must make it unambiguous when the model should select it versus a similar tool.",
              weight: 0.5,
              score_anchors: {
                "0": "Tools share overlapping descriptions with no clear selection criteria.",
                "3": "Descriptions mention shape but still overlap on one or two axes.",
                "5": "Each description names the input shape, the exact use case, and the boundary with sibling tools.",
              },
            },
            {
              id: "tool_count_fits_loop",
              title: "Tool count and specificity fit the agentic loop",
              description:
                "The exercise asks for 3-4 tools including two with similar functionality — the design must respect those constraints.",
              weight: 0.3,
              score_anchors: {
                "0": "Wrong count (<3 or >4) or no near-duplicates included.",
                "3": "Correct count but near-duplicates collapse into one tool.",
                "5": "Correct count with two carefully-differentiated sibling tools.",
              },
            },
            {
              id: "input_output_shapes",
              title: "Documents expected inputs and boundary conditions",
              description:
                "Tool descriptions must note expected input shape and the boundary conditions (error inputs, missing fields) the tool handles.",
              weight: 0.2,
              score_anchors: {
                "0": "No input shape or boundary conditions given.",
                "3": "Shapes listed but boundaries missing.",
                "5": "Both input shape and boundary/error cases documented per tool.",
              },
            },
          ],
        },
      },
    ],
  };
}

describe("exercise step catalog", () => {
  let handle: ReturnType<typeof freshDb>;

  beforeEach(() => {
    handle = freshDb();
    seedCurriculum(handle.db);
    callClaudeMock.mockReset();
  });

  it("listExercises returns exercises with step counts in orderIndex order", () => {
    const rows = listExercises(handle.db);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("EX1");
    expect(rows[0].stepCount).toBe(2);
    expect(rows[0].domainsReinforced).toEqual(["D1"]);
    handle.close();
  });

  it("getExercise returns detail with steps sorted by stepIdx", () => {
    const ex = getExercise("EX1", handle.db);
    expect(ex).not.toBeNull();
    expect(ex?.steps.map((s) => s.stepIdx)).toEqual([0, 1]);
    expect(ex?.steps[0].hasRubric).toBe(false);
    handle.close();
  });

  it("getExercise returns null for unknown id", () => {
    expect(getExercise("NOPE", handle.db)).toBeNull();
    handle.close();
  });

  it("getStep returns a summary or null", () => {
    expect(getStep("EX1-S0", handle.db)?.prompt).toMatch(/MCP tools/);
    expect(getStep("NOPE", handle.db)).toBeNull();
    handle.close();
  });

  it("resolveReinforcedTaskStatements expands domain ids to all member TS", () => {
    const ids = resolveReinforcedTaskStatements(["D1"], handle.db);
    expect(ids.sort()).toEqual(["D1.1", "D1.2"]);
    handle.close();
  });

  it("resolveReinforcedTaskStatements accepts explicit TS ids", () => {
    const ids = resolveReinforcedTaskStatements(["D4.1"], handle.db);
    expect(ids).toEqual(["D4.1"]);
    handle.close();
  });

  it("resolveReinforcedTaskStatements mixes domain and explicit entries, de-duped", () => {
    const ids = resolveReinforcedTaskStatements(["D1", "D1.1", "D4.1"], handle.db);
    expect(ids.sort()).toEqual(["D1.1", "D1.2", "D4.1"]);
    handle.close();
  });

  it("getOrGenerateStepRubric calls Claude on first call and caches the result", async () => {
    callClaudeMock.mockResolvedValueOnce(cannedRubricMessage());
    const first = await getOrGenerateStepRubric("EX1-S0", { db: handle.db });
    expect(first.cached).toBe(false);
    expect(first.rubric.criteria).toHaveLength(3);
    expect(callClaudeMock).toHaveBeenCalledTimes(1);

    const second = await getOrGenerateStepRubric("EX1-S0", { db: handle.db });
    expect(second.cached).toBe(true);
    expect(callClaudeMock).toHaveBeenCalledTimes(1); // cached, no new call
    handle.close();
  });

  it("getOrGenerateStepRubric persists rubric and rubric_generated_at on first call", async () => {
    callClaudeMock.mockResolvedValueOnce(cannedRubricMessage());
    await getOrGenerateStepRubric("EX1-S0", { db: handle.db });
    const row = handle.db
      .select()
      .from(schema.preparationSteps)
      .where(eq(schema.preparationSteps.id, "EX1-S0"))
      .get();
    expect(row?.rubric).not.toBeNull();
    expect(row?.rubricGeneratedAt).toBeInstanceOf(Date);
    handle.close();
  });

  it("getOrGenerateStepRubric builds a system prompt citing the reinforced TS bullets", async () => {
    callClaudeMock.mockResolvedValueOnce(cannedRubricMessage());
    await getOrGenerateStepRubric("EX1-S0", { db: handle.db });
    const call = callClaudeMock.mock.calls[0][0];
    expect(call.system).toMatch(/D1\.1[\s\S]*Agentic loops/);
    expect(call.system).toMatch(/D1\.2[\s\S]*Tool design/);
    // Step 0 of 2 → both should be mentioned in the template render.
    expect(call.system).toMatch(/Step 0 of 2/);
    expect(call.tools).toHaveLength(1);
    expect(call.tools[0].name).toBe("emit_rubric");
    expect(call.toolChoice).toEqual({ type: "tool", name: "emit_rubric" });
    handle.close();
  });

  it("getOrGenerateStepRubric forceRegenerate ignores cache and re-calls Claude", async () => {
    callClaudeMock.mockResolvedValue(cannedRubricMessage());
    await getOrGenerateStepRubric("EX1-S0", { db: handle.db });
    await getOrGenerateStepRubric("EX1-S0", {
      db: handle.db,
      forceRegenerate: true,
    });
    expect(callClaudeMock).toHaveBeenCalledTimes(2);
    handle.close();
  });

  it("getOrGenerateStepRubric throws not_found for unknown step", async () => {
    await expect(
      getOrGenerateStepRubric("NOPE", { db: handle.db }),
    ).rejects.toThrow(ExerciseError);
    handle.close();
  });

  it("getOrGenerateStepRubric throws bad_tool_output when Claude returns malformed rubric", async () => {
    callClaudeMock.mockResolvedValueOnce({
      ...cannedRubricMessage(),
      content: [
        {
          type: "tool_use" as const,
          id: "tu_bad",
          name: "emit_rubric",
          input: { criteria: [] }, // fails min(3)
        },
      ],
    });
    await expect(
      getOrGenerateStepRubric("EX1-S0", { db: handle.db }),
    ).rejects.toMatchObject({ code: "bad_tool_output" });
    handle.close();
  });

  it("getOrGenerateStepRubric throws no_tool_use when Claude returns plain text", async () => {
    callClaudeMock.mockResolvedValueOnce({
      ...cannedRubricMessage(),
      stop_reason: "end_turn" as const,
      content: [{ type: "text" as const, text: "I refuse." }],
    });
    await expect(
      getOrGenerateStepRubric("EX1-S0", { db: handle.db }),
    ).rejects.toMatchObject({ code: "no_tool_use" });
    handle.close();
  });

  it("readStepRubricCache returns null before generation and the rubric after", async () => {
    expect(readStepRubricCache("EX1-S0", handle.db)).toBeNull();
    callClaudeMock.mockResolvedValueOnce(cannedRubricMessage());
    await getOrGenerateStepRubric("EX1-S0", { db: handle.db });
    const cached = readStepRubricCache("EX1-S0", handle.db);
    expect(cached).not.toBeNull();
    expect(cached?.cached).toBe(true);
    expect(cached?.rubric.criteria).toHaveLength(3);
    handle.close();
  });

  it("loadPriorStepArtifacts returns latest attempt per step up to beforeStepIdx", () => {
    // Step 0 has two attempts; step 1 has one; we're grading step 2 so we
    // expect latest(S0) and only(S1), in step order.
    const now = Date.now();
    handle.db
      .insert(schema.preparationAttempts)
      .values([
        {
          id: randomUUID(),
          stepId: "EX1-S0",
          artifactText: "old s0",
          grade: 2.0,
          feedback: null,
          ts: new Date(now - 10_000),
        },
        {
          id: randomUUID(),
          stepId: "EX1-S0",
          artifactText: "new s0",
          grade: 4.0,
          feedback: null,
          ts: new Date(now),
        },
        {
          id: randomUUID(),
          stepId: "EX1-S1",
          artifactText: "s1 only",
          grade: 3.5,
          feedback: null,
          ts: new Date(now - 5_000),
        },
      ])
      .run();
    const prior = loadPriorStepArtifacts("EX1", 2, handle.db);
    expect(prior).toHaveLength(2);
    expect(prior[0].stepIdx).toBe(0);
    expect(prior[0].artifactText).toBe("new s0");
    expect(prior[1].stepIdx).toBe(1);
    expect(prior[1].artifactText).toBe("s1 only");
    handle.close();
  });

  it("loadPriorStepArtifacts excludes attempts at or beyond beforeStepIdx", () => {
    handle.db
      .insert(schema.preparationAttempts)
      .values([
        {
          id: randomUUID(),
          stepId: "EX1-S0",
          artifactText: "s0",
          grade: 4.0,
          feedback: null,
          ts: new Date(),
        },
        {
          id: randomUUID(),
          stepId: "EX1-S1",
          artifactText: "s1",
          grade: 4.0,
          feedback: null,
          ts: new Date(),
        },
      ])
      .run();
    // Grading step 1 → only step 0 is prior
    const prior = loadPriorStepArtifacts("EX1", 1, handle.db);
    expect(prior).toHaveLength(1);
    expect(prior[0].stepId).toBe("EX1-S0");
    handle.close();
  });
});
