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

const { createScenarioPrompt } = await import("../lib/scenarios/prompts");
const {
  gradeScenarioAttempt,
  getScenarioAttempt,
  listAttemptsForPrompt,
  ScenarioGradeError,
} = await import("../lib/scenarios/grade");
type GraderCallInspector = import("../lib/scenarios/grade").GraderCallInspector;

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
        "You are building a customer support resolution agent using the Claude Agent SDK with MCP tools and an escalate_to_human option.",
      orderIndex: 0,
    })
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
      id: "escalation_triggers",
      title: "Lists distinct escalation triggers",
      description:
        "The answer must name the specific signals that move the decision to escalate rather than clarify or self-serve.",
      weight: 0.5,
      score_anchors: {
        "0": "No escalation triggers named at all.",
        "3": "Names one trigger but does not distinguish it from clarify-then-retry.",
        "5": "Names three distinct triggers and explains how each differs.",
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
        "5": "Enumerates the specific fields: customer, order, tool history.",
      },
    },
    {
      id: "over_escalation_guard",
      title: "Prevents over-escalating low-ambiguity cases",
      description:
        "The answer must describe how the policy stays quiet when a case is clearly self-servable.",
      weight: 0.2,
      score_anchors: {
        "0": "No discussion of when NOT to escalate.",
        "3": "Notes the problem but no mechanism.",
        "5": "Names a concrete gate: one trigger above threshold, not any uncertainty at all.",
      },
    },
  ],
};

const gradePayload = {
  overall_score: 4.2,
  per_criterion: [
    {
      id: "escalation_triggers",
      score: 4,
      reasoning:
        "Answer names explicit_ask and three_failed_hints but misses the policy_gap trigger.",
    },
    {
      id: "handoff_payload",
      score: 5,
      reasoning:
        "Enumerates customer id, order state, and recent tool calls — full payload.",
    },
  ],
  strengths: [
    "Clearly names two of the three escalation triggers.",
    "Specifies the exact fields handed to the human on escalation.",
  ],
  gaps: [
    "Add the policy_gap trigger from D5.2 — the case where the agent has no authoritative rule to apply.",
  ],
  model_answer:
    "A well-designed escalation policy has three clearly-named triggers: explicit user ask for a human, three consecutive failed hints, and a policy gap where the agent has no authoritative rule to apply. On trigger, the agent calls escalate_to_human with the customer id, the order or account state that prompted the question, the tool history (what the agent has already tried), and the specific trigger that fired. The policy actively avoids over-escalating low-ambiguity cases by requiring one trigger above threshold rather than any uncertainty at all.",
};

function mockFirstRubricThenGrade(): void {
  callClaudeMock
    .mockResolvedValueOnce(
      baseMessage([
        { type: "tool_use", id: "tu_1", name: "emit_rubric", input: rubricPayload },
      ]),
    )
    .mockResolvedValueOnce(
      baseMessage([
        { type: "tool_use", id: "tu_2", name: "record_grade", input: gradePayload },
      ]),
    );
}

describe("gradeScenarioAttempt — AT17 grader isolation", () => {
  let handle: ReturnType<typeof freshDb>;
  let promptId: string;
  const ANSWER =
    "The agent escalates when the customer explicitly asks for a human OR when three consecutive hints have failed. On escalation, the agent passes the customer record, the current order state, and the tool call history so the human doesn't start from zero.";

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
  });

  it("offers ONLY the record_grade tool with tool_choice forcing it (AT17)", async () => {
    mockFirstRubricThenGrade();
    let captured: GraderCallInspector | null = null;

    await gradeScenarioAttempt(promptId, ANSWER, {
      db: handle.db,
      onGraderCall: (insp) => {
        captured = insp;
      },
    });

    expect(captured).not.toBeNull();
    const cap = captured!;
    expect(cap.tools).toHaveLength(1);
    expect(cap.tools[0].name).toBe("record_grade");
    expect(cap.toolChoice).toEqual({
      type: "tool",
      name: "record_grade",
    });
    handle.close();
  });

  it("builds the system prompt from rubric + scenario + answer ONLY — no tutor state leaks (AT17)", async () => {
    // Add a dangling tutor_session to the DB to prove the grader doesn't pull it.
    handle.db
      .insert(schema.tutorSessions)
      .values({
        id: "sess_should_not_appear",
        topicId: "D5.2",
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
    await gradeScenarioAttempt(promptId, ANSWER, {
      db: handle.db,
      onGraderCall: (insp) => {
        captured = insp.systemPrompt;
      },
    });

    expect(captured).not.toBeNull();
    const prompt = captured!;
    // Must contain the rubric + scenario + user answer
    expect(prompt).toContain("Customer Support Resolution Agent");
    expect(prompt).toContain("escalation_triggers");
    expect(prompt).toContain(ANSWER);
    expect(prompt).toContain("D5.2");
    // Must NOT contain tutor session content
    expect(prompt).not.toContain("SECRET_TUTOR_CHAT_STRING");
    expect(prompt).not.toContain("sess_should_not_appear");
    handle.close();
  });

  it("persists an attempt row and a scenario_grade progress event on success", async () => {
    mockFirstRubricThenGrade();
    const result = await gradeScenarioAttempt(promptId, ANSWER, {
      db: handle.db,
      now: new Date("2026-04-14T12:00:00Z"),
    });

    expect(result.overallScore).toBe(4.2);
    expect(result.success).toBe(true);
    expect(result.strengths.length).toBeGreaterThanOrEqual(1);
    expect(result.gaps.length).toBeGreaterThanOrEqual(1);
    expect(result.modelAnswer.length).toBeGreaterThan(100);

    const attemptRow = handle.db
      .select()
      .from(schema.scenarioAttempts)
      .where(eq(schema.scenarioAttempts.id, result.attemptId))
      .get();
    expect(attemptRow).toBeDefined();
    expect(attemptRow?.overallScore).toBe(4.2);
    expect(attemptRow?.progressEventId).toBe(result.eventId);

    const eventRow = handle.db
      .select()
      .from(schema.progressEvents)
      .where(eq(schema.progressEvents.id, result.eventId))
      .get();
    expect(eventRow?.kind).toBe("scenario_grade");
    expect(eventRow?.taskStatementId).toBe("D5.2");
    expect(eventRow?.bloomLevel).toBe(4);
    expect(eventRow?.success).toBe(true);

    const mastery = handle.db
      .select()
      .from(schema.masterySnapshots)
      .where(
        and(
          eq(schema.masterySnapshots.taskStatementId, "D5.2"),
          eq(schema.masterySnapshots.bloomLevel, 4),
        ),
      )
      .get();
    expect(mastery).toBeDefined();
    expect(mastery?.itemCount).toBe(1);
    handle.close();
  });

  it("marks success=false when overall_score < 3.0", async () => {
    callClaudeMock
      .mockResolvedValueOnce(
        baseMessage([
          { type: "tool_use", id: "tu_1", name: "emit_rubric", input: rubricPayload },
        ]),
      )
      .mockResolvedValueOnce(
        baseMessage([
          {
            type: "tool_use",
            id: "tu_2",
            name: "record_grade",
            input: {
              ...gradePayload,
              overall_score: 2.4,
            },
          },
        ]),
      );

    const result = await gradeScenarioAttempt(promptId, ANSWER, {
      db: handle.db,
    });
    expect(result.success).toBe(false);
    const eventRow = handle.db
      .select()
      .from(schema.progressEvents)
      .where(eq(schema.progressEvents.id, result.eventId))
      .get();
    expect(eventRow?.success).toBe(false);
    handle.close();
  });

  it("reuses the cached rubric on second attempt — one Claude call, not two (RD4)", async () => {
    mockFirstRubricThenGrade();
    await gradeScenarioAttempt(promptId, ANSWER, { db: handle.db });
    expect(callClaudeMock).toHaveBeenCalledTimes(2); // rubric + grade

    // Second attempt: rubric is cached, so only one grader call should fire.
    callClaudeMock.mockResolvedValueOnce(
      baseMessage([
        {
          type: "tool_use",
          id: "tu_3",
          name: "record_grade",
          input: gradePayload,
        },
      ]),
    );
    await gradeScenarioAttempt(promptId, ANSWER, { db: handle.db });
    expect(callClaudeMock).toHaveBeenCalledTimes(3); // +1, not +2
    handle.close();
  });

  it("rejects answers shorter than 20 characters before calling Claude", async () => {
    await expect(
      gradeScenarioAttempt(promptId, "too short", { db: handle.db }),
    ).rejects.toMatchObject({ code: "answer_too_short" });
    expect(callClaudeMock).not.toHaveBeenCalled();
    handle.close();
  });

  it("surfaces no_tool_use when the model returns text instead of calling record_grade", async () => {
    callClaudeMock
      .mockResolvedValueOnce(
        baseMessage([
          { type: "tool_use", id: "tu_1", name: "emit_rubric", input: rubricPayload },
        ]),
      )
      .mockResolvedValueOnce(
        baseMessage(
          [{ type: "text", text: "Sorry, I can't grade this." }],
          "end_turn",
        ),
      );
    await expect(
      gradeScenarioAttempt(promptId, ANSWER, { db: handle.db }),
    ).rejects.toMatchObject({ code: "no_tool_use" });
    handle.close();
  });

  it("surfaces bad_tool_output when record_grade violates the schema", async () => {
    callClaudeMock
      .mockResolvedValueOnce(
        baseMessage([
          { type: "tool_use", id: "tu_1", name: "emit_rubric", input: rubricPayload },
        ]),
      )
      .mockResolvedValueOnce(
        baseMessage([
          {
            type: "tool_use",
            id: "tu_2",
            name: "record_grade",
            input: {
              ...gradePayload,
              overall_score: 7.5, // out of 0-5 range
            },
          },
        ]),
      );
    await expect(
      gradeScenarioAttempt(promptId, ANSWER, { db: handle.db }),
    ).rejects.toMatchObject({ code: "bad_tool_output" });
    handle.close();
  });

  it("throws not_found on unknown promptId", async () => {
    await expect(
      gradeScenarioAttempt(
        "nope-id-unknown",
        "This is a valid-length answer even if wrong.",
        { db: handle.db },
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(callClaudeMock).not.toHaveBeenCalled();
    handle.close();
  });

  it("listAttemptsForPrompt returns attempts newest-first", async () => {
    mockFirstRubricThenGrade();
    const first = await gradeScenarioAttempt(promptId, ANSWER, {
      db: handle.db,
      now: new Date("2026-04-13T12:00:00Z"),
    });

    callClaudeMock.mockResolvedValueOnce(
      baseMessage([
        { type: "tool_use", id: "tu_3", name: "record_grade", input: gradePayload },
      ]),
    );
    const second = await gradeScenarioAttempt(promptId, ANSWER, {
      db: handle.db,
      now: new Date("2026-04-14T12:00:00Z"),
    });

    const list = listAttemptsForPrompt(promptId, handle.db);
    expect(list.map((a) => a.id)).toEqual([second.attemptId, first.attemptId]);
    handle.close();
  });

  it("getScenarioAttempt roundtrips feedback + model_answer", async () => {
    mockFirstRubricThenGrade();
    const result = await gradeScenarioAttempt(promptId, ANSWER, { db: handle.db });
    const stored = getScenarioAttempt(result.attemptId, handle.db);
    expect(stored).not.toBeNull();
    expect(stored?.perCriterion).toHaveLength(2);
    expect(stored?.modelAnswer).toContain("escalate_to_human");
    expect(stored?.answerText).toBe(ANSWER);
    handle.close();
  });
});

describe("ScenarioGradeError shape", () => {
  it("exposes code and message like sibling module errors", () => {
    const e = new ScenarioGradeError("answer_too_short", "boom");
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe("answer_too_short");
    expect(e.message).toBe("boom");
    expect(e.name).toBe("ScenarioGradeError");
  });
});
