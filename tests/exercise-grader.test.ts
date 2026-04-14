import Database from "better-sqlite3";
import { and, eq } from "drizzle-orm";
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
  gradeExerciseStep,
  listAttemptsForStep,
  getLatestAttemptForStep,
  ExerciseGradeError,
} = await import("../lib/exercises/grade");
type GraderCallInspector = import("../lib/exercises/grade").GraderCallInspector;

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
    .values([
      { id: "D1", title: "Domain 1", weightBps: 2700, orderIndex: 1 },
      { id: "D4", title: "Domain 4", weightBps: 2000, orderIndex: 4 },
    ])
    .run();
  db.insert(schema.taskStatements)
    .values([
      {
        id: "D1.1",
        domainId: "D1",
        title: "Agentic loops",
        knowledgeBullets: ["stop_reason semantics"],
        skillsBullets: ["Inspect stop_reason"],
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

function baseMessage(
  contentBlocks: Array<
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: unknown }
  >,
  stopReason: "tool_use" | "end_turn" = "tool_use",
) {
  return {
    id: "msg_test",
    type: "message" as const,
    role: "assistant" as const,
    model: "claude-sonnet-4-6",
    stop_reason: stopReason,
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
    content: contentBlocks,
  };
}

const rubricPayload = {
  criteria: [
    {
      id: "tool_differentiation",
      title: "Tools have distinct, bounded descriptions",
      description:
        "Each tool's description must make it unambiguous when the model should select it versus a similar tool.",
      weight: 0.5,
      score_anchors: {
        "0": "Tools share overlapping descriptions with no clear selection criteria.",
        "3": "Descriptions mention shape but overlap on one or two axes.",
        "5": "Each description names the input shape and the boundary with sibling tools.",
      },
    },
    {
      id: "tool_count_fits_loop",
      title: "Tool count and specificity fit the agentic loop",
      description:
        "The exercise asks for 3-4 tools — the design must respect those constraints.",
      weight: 0.3,
      score_anchors: {
        "0": "Wrong count (<3 or >4).",
        "3": "Correct count but near-duplicates collapse.",
        "5": "Correct count with two carefully-differentiated siblings.",
      },
    },
    {
      id: "input_output_shapes",
      title: "Documents expected inputs and boundary conditions",
      description:
        "Tool descriptions must note expected input shape and boundary conditions.",
      weight: 0.2,
      score_anchors: {
        "0": "No input shape or boundary conditions.",
        "3": "Shapes listed but boundaries missing.",
        "5": "Both input shape and boundary/error cases documented per tool.",
      },
    },
  ],
};

const gradePayload = {
  overall_score: 4.2,
  per_criterion: [
    {
      id: "tool_differentiation",
      score: 4,
      reasoning:
        "Candidate defines search_orders and search_customers with distinct input shapes; boundary cases on sibling tools are named but not exhaustive.",
    },
    {
      id: "tool_count_fits_loop",
      score: 5,
      reasoning:
        "Four tools defined, including two near-duplicates (search_orders/search_customers) that are distinguished by the `entity` parameter and return shape.",
    },
    {
      id: "input_output_shapes",
      score: 3,
      reasoning:
        "Inputs are specified per tool but boundary failure modes are only mentioned for search_orders, not the other three.",
    },
  ],
  strengths: [
    "Names concrete input shape (object with entity and query fields) for every tool.",
    "Distinguishes the two sibling tools by both the entity parameter and the return shape, not just the name.",
  ],
  gaps: [
    "Add boundary-condition documentation (missing inputs, 404s) to the other three tool descriptions, not just search_orders.",
  ],
  model_answer:
    "A clean four-tool MCP set for a support agent might include: (1) search_orders(customer_id, status?) returning [order] with 404 on missing customer; (2) search_customers(query) returning [customer_ref] with empty-list on no match (never 404); (3) get_tool_history(session_id) returning [tool_call] with 404 on expired session; (4) escalate_to_human(reason, payload) returning {ticket_id}. The description for search_orders and search_customers must specify: the entity shape they return (orders vs customer_refs), the ambiguity boundary (search_customers handles partial name queries; search_orders requires an exact customer_id), and the failure modes (404 vs empty-list). Differentiation is carried by the input shape AND the return shape — both are documented.",
};

function mockFirstRubricThenGrade(): void {
  callClaudeMock
    .mockResolvedValueOnce(
      baseMessage([
        { type: "tool_use", id: "tu_r", name: "emit_rubric", input: rubricPayload },
      ]),
    )
    .mockResolvedValueOnce(
      baseMessage([
        { type: "tool_use", id: "tu_g", name: "record_grade", input: gradePayload },
      ]),
    );
}

const ARTIFACT =
  "Four MCP tools. 1) search_orders(customer_id, status?) returning [order]. 404 on missing customer, empty list on no matches. 2) search_customers(query) returning [customer_ref]. Empty list on no match (never 404). 3) get_tool_history(session_id) returning [tool_call]. 4) escalate_to_human(reason, payload) returning {ticket_id}. Siblings differentiated by entity shape.";

describe("gradeExerciseStep — FR2.7 step grader", () => {
  let handle: ReturnType<typeof freshDb>;

  beforeEach(() => {
    handle = freshDb();
    seedCurriculum(handle.db);
    callClaudeMock.mockReset();
  });

  it("offers ONLY the record_grade tool with forced tool_choice (AT17 pattern)", async () => {
    mockFirstRubricThenGrade();
    let captured: GraderCallInspector | null = null;
    await gradeExerciseStep("EX1-S0", ARTIFACT, {
      db: handle.db,
      onGraderCall: (insp) => {
        captured = insp;
      },
    });
    expect(captured).not.toBeNull();
    const cap = captured!;
    expect(cap.tools).toHaveLength(1);
    expect(cap.tools[0].name).toBe("record_grade");
    expect(cap.toolChoice).toEqual({ type: "tool", name: "record_grade" });
    handle.close();
  });

  it("builds the system prompt from exercise + rubric + artifact ONLY — no tutor state leaks", async () => {
    handle.db
      .insert(schema.tutorSessions)
      .values({
        id: "sess_should_not_appear",
        topicId: "D1.1",
        messages: [
          {
            role: "user",
            content: "SECRET_TUTOR_CHAT_STRING_that_should_not_be_in_grader",
          },
        ],
      })
      .run();

    mockFirstRubricThenGrade();
    let captured: string | null = null;
    await gradeExerciseStep("EX1-S0", ARTIFACT, {
      db: handle.db,
      onGraderCall: (insp) => {
        captured = insp.systemPrompt;
      },
    });

    expect(captured).not.toBeNull();
    const prompt = captured!;
    expect(prompt).toContain("Build a Multi-Tool Agent");
    expect(prompt).toContain("tool_differentiation");
    expect(prompt).toContain(ARTIFACT);
    expect(prompt).not.toContain("SECRET_TUTOR_CHAT_STRING");
    expect(prompt).not.toContain("sess_should_not_appear");
    handle.close();
  });

  it("writes one exercise_step_grade event per reinforced TS at Bloom 6 (AT16)", async () => {
    mockFirstRubricThenGrade();
    const result = await gradeExerciseStep("EX1-S0", ARTIFACT, {
      db: handle.db,
      now: new Date("2026-04-14T12:00:00Z"),
    });

    // EX1 reinforces D1 → expands to D1.1 + D1.2 (D4.1 NOT included)
    expect(result.reinforcedTaskStatementIds.sort()).toEqual(["D1.1", "D1.2"]);
    expect(result.eventIds).toHaveLength(2);

    const events = handle.db
      .select()
      .from(schema.progressEvents)
      .all();
    expect(events).toHaveLength(2);
    for (const e of events) {
      expect(e.kind).toBe("exercise_step_grade");
      expect(e.bloomLevel).toBe(6);
      expect(e.success).toBe(true);
      expect(["D1.1", "D1.2"]).toContain(e.taskStatementId);
      const payload = e.payload as {
        exerciseId: string;
        stepId: string;
        stepIdx: number;
      };
      expect(payload.exerciseId).toBe("EX1");
      expect(payload.stepId).toBe("EX1-S0");
      expect(payload.stepIdx).toBe(0);
    }
    handle.close();
  });

  it("refreshes mastery snapshots for every reinforced (TS, L6) cell", async () => {
    mockFirstRubricThenGrade();
    const result = await gradeExerciseStep("EX1-S0", ARTIFACT, {
      db: handle.db,
    });
    expect(result.masterySnapshots.map((s) => s.taskStatementId).sort()).toEqual([
      "D1.1",
      "D1.2",
    ]);
    for (const snap of result.masterySnapshots) {
      expect(snap.itemCount).toBe(1);
      expect(snap.score).toBeGreaterThan(0);
    }
    const dbSnaps = handle.db
      .select()
      .from(schema.masterySnapshots)
      .where(eq(schema.masterySnapshots.bloomLevel, 6))
      .all();
    expect(dbSnaps).toHaveLength(2);
    handle.close();
  });

  it("writes a preparation_attempts row with feedback JSON", async () => {
    mockFirstRubricThenGrade();
    const result = await gradeExerciseStep("EX1-S0", ARTIFACT, {
      db: handle.db,
    });
    const row = handle.db
      .select()
      .from(schema.preparationAttempts)
      .where(eq(schema.preparationAttempts.id, result.attemptId))
      .get();
    expect(row).toBeDefined();
    expect(row?.grade).toBe(4.2);
    expect(row?.artifactText).toBe(ARTIFACT);
    const fb = row?.feedback as {
      strengths: string[];
      gaps: string[];
      modelAnswer: string;
      reinforcedTaskStatementIds: string[];
    };
    expect(fb.strengths.length).toBeGreaterThanOrEqual(1);
    expect(fb.gaps.length).toBeGreaterThanOrEqual(1);
    expect(fb.modelAnswer.length).toBeGreaterThan(50);
    expect(fb.reinforcedTaskStatementIds.sort()).toEqual(["D1.1", "D1.2"]);
    handle.close();
  });

  it("success=false when overall_score < 3.0 (below threshold)", async () => {
    callClaudeMock
      .mockResolvedValueOnce(
        baseMessage([
          { type: "tool_use", id: "tu_r", name: "emit_rubric", input: rubricPayload },
        ]),
      )
      .mockResolvedValueOnce(
        baseMessage([
          {
            type: "tool_use",
            id: "tu_g",
            name: "record_grade",
            input: { ...gradePayload, overall_score: 2.5 },
          },
        ]),
      );
    const result = await gradeExerciseStep("EX1-S0", ARTIFACT, {
      db: handle.db,
    });
    expect(result.success).toBe(false);
    const events = handle.db
      .select()
      .from(schema.progressEvents)
      .all();
    for (const e of events) {
      expect(e.success).toBe(false);
    }
    handle.close();
  });

  it("D1.4 multi-step handoff — grading step 1 includes prior step-0 artifact in the system prompt", async () => {
    // First: grade step 0 successfully.
    mockFirstRubricThenGrade();
    const step0Artifact =
      "Four MCP tools: search_orders, search_customers, get_tool_history, escalate_to_human. Descriptions above.";
    await gradeExerciseStep("EX1-S0", step0Artifact, { db: handle.db });

    // Now: grade step 1; the rubric for step 1 is new, and the grader should
    // see the step-0 artifact in its context.
    callClaudeMock
      .mockResolvedValueOnce(
        baseMessage([
          { type: "tool_use", id: "tu_r2", name: "emit_rubric", input: rubricPayload },
        ]),
      )
      .mockResolvedValueOnce(
        baseMessage([
          {
            type: "tool_use",
            id: "tu_g2",
            name: "record_grade",
            input: gradePayload,
          },
        ]),
      );

    let captured: string | null = null;
    const step1Artifact =
      "Agentic loop: while stop_reason === 'tool_use', run the requested tools (from step 0), append tool_result blocks, loop. Break on end_turn.";
    await gradeExerciseStep("EX1-S1", step1Artifact, {
      db: handle.db,
      onGraderCall: (insp) => {
        captured = insp.systemPrompt;
      },
    });

    expect(captured).not.toBeNull();
    const prompt = captured!;
    // Step 1's grader sees step 0's artifact as "Prior steps" context.
    expect(prompt).toContain("Prior steps");
    expect(prompt).toContain(step0Artifact);
    expect(prompt).toContain(step1Artifact);
    handle.close();
  });

  it("first step grading shows '(None — this is the first step being graded.)' for prior artifacts", async () => {
    mockFirstRubricThenGrade();
    let captured: string | null = null;
    await gradeExerciseStep("EX1-S0", ARTIFACT, {
      db: handle.db,
      onGraderCall: (insp) => {
        captured = insp.systemPrompt;
      },
    });
    expect(captured).not.toBeNull();
    expect(captured!).toContain("None — this is the first step being graded");
    handle.close();
  });

  it("rubric is reused from cache on the second grading of the same step (RD4-style cache)", async () => {
    mockFirstRubricThenGrade();
    await gradeExerciseStep("EX1-S0", ARTIFACT, { db: handle.db });
    expect(callClaudeMock).toHaveBeenCalledTimes(2); // rubric + grade

    // Second grading: rubric is cached, only the grade call fires.
    callClaudeMock.mockResolvedValueOnce(
      baseMessage([
        { type: "tool_use", id: "tu_g2", name: "record_grade", input: gradePayload },
      ]),
    );
    await gradeExerciseStep("EX1-S0", ARTIFACT, { db: handle.db });
    expect(callClaudeMock).toHaveBeenCalledTimes(3); // only +1 (grade)
    handle.close();
  });

  it("throws artifact_too_short before any Claude call when artifact is under 20 chars", async () => {
    await expect(
      gradeExerciseStep("EX1-S0", "too short", { db: handle.db }),
    ).rejects.toMatchObject({ code: "artifact_too_short" });
    expect(callClaudeMock).not.toHaveBeenCalled();
    handle.close();
  });

  it("throws artifact_too_long before any Claude call when artifact exceeds 20000 chars", async () => {
    const huge = "x".repeat(20_001);
    await expect(
      gradeExerciseStep("EX1-S0", huge, { db: handle.db }),
    ).rejects.toMatchObject({ code: "artifact_too_long" });
    expect(callClaudeMock).not.toHaveBeenCalled();
    handle.close();
  });

  it("throws bad_tool_output when the grader returns malformed input", async () => {
    callClaudeMock
      .mockResolvedValueOnce(
        baseMessage([
          { type: "tool_use", id: "tu_r", name: "emit_rubric", input: rubricPayload },
        ]),
      )
      .mockResolvedValueOnce(
        baseMessage([
          {
            type: "tool_use",
            id: "tu_g",
            name: "record_grade",
            input: { overall_score: "not a number" },
          },
        ]),
      );
    await expect(
      gradeExerciseStep("EX1-S0", ARTIFACT, { db: handle.db }),
    ).rejects.toMatchObject({ code: "bad_tool_output" });
    handle.close();
  });

  it("throws no_tool_use when the grader returns plain text instead of calling record_grade", async () => {
    callClaudeMock
      .mockResolvedValueOnce(
        baseMessage([
          { type: "tool_use", id: "tu_r", name: "emit_rubric", input: rubricPayload },
        ]),
      )
      .mockResolvedValueOnce(
        baseMessage([{ type: "text", text: "I refuse." }], "end_turn"),
      );
    await expect(
      gradeExerciseStep("EX1-S0", ARTIFACT, { db: handle.db }),
    ).rejects.toMatchObject({ code: "no_tool_use" });
    handle.close();
  });

  it("throws ExerciseError not_found for unknown stepId before any Claude call", async () => {
    await expect(
      gradeExerciseStep("NOPE", ARTIFACT, { db: handle.db }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(callClaudeMock).not.toHaveBeenCalled();
    handle.close();
  });

  it("ExerciseGradeError code is propagated for orchestration errors", async () => {
    // sanity: make sure the exported error constructor is stable
    const e = new ExerciseGradeError("foo", "msg");
    expect(e.code).toBe("foo");
    expect(e).toBeInstanceOf(Error);
    handle.close();
  });

  it("listAttemptsForStep returns attempts newest-first; getLatestAttemptForStep returns the most recent", async () => {
    mockFirstRubricThenGrade();
    const first = await gradeExerciseStep("EX1-S0", ARTIFACT, {
      db: handle.db,
      now: new Date("2026-04-01T12:00:00Z"),
    });
    callClaudeMock.mockResolvedValueOnce(
      baseMessage([
        { type: "tool_use", id: "tu_g2", name: "record_grade", input: gradePayload },
      ]),
    );
    const second = await gradeExerciseStep("EX1-S0", ARTIFACT, {
      db: handle.db,
      now: new Date("2026-04-05T12:00:00Z"),
    });
    const list = listAttemptsForStep("EX1-S0", handle.db);
    expect(list.map((a) => a.id)).toEqual([second.attemptId, first.attemptId]);
    expect(getLatestAttemptForStep("EX1-S0", handle.db)?.id).toBe(
      second.attemptId,
    );
    // silence unused-var lint on and/eq (imported for future direct-DB
    // assertions).
    void and;
    void eq;
    handle.close();
  });
});
