import { describe, expect, it } from "vitest";
import {
  recordGradeInputSchema,
  recordGradeTool,
} from "../lib/claude/roles/grader";
import {
  emitRubricInputSchema,
  emitRubricTool,
} from "../lib/claude/roles/rubric-drafter";

describe("record_grade tool schema (FR2.4)", () => {
  const validPayload = {
    overall_score: 3.5,
    per_criterion: [
      {
        id: "tool_choice_rationale",
        score: 4,
        reasoning:
          "Answer names Tool.Tool and tool_choice=auto, but skips the tool_result retry loop.",
      },
      {
        id: "escalation_policy",
        score: 3,
        reasoning: "Mentions three_failed_hints but not explicit_ask or policy_gap.",
      },
    ],
    strengths: ["Correctly identifies tool_choice=auto as the default."],
    gaps: ["Missing the D5.2 policy_gap trigger as a third escalation cause."],
    model_answer:
      "A well-designed coordinator sets tool_choice=auto so the subagent can decline, wires the tool_result carrier user message back into the loop, and escalates when any of the three D5.2 triggers fires: explicit user ask, three consecutive failed hints, or policy gap.",
  };

  it("accepts a well-formed payload", () => {
    const parsed = recordGradeInputSchema.safeParse(validPayload);
    expect(parsed.success).toBe(true);
  });

  it("rejects overall_score out of 0-5 range", () => {
    const bad = { ...validPayload, overall_score: 5.7 };
    expect(recordGradeInputSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects non-integer criterion score", () => {
    const bad = {
      ...validPayload,
      per_criterion: [
        { ...validPayload.per_criterion[0], score: 3.5 },
        validPayload.per_criterion[1],
      ],
    };
    expect(recordGradeInputSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects empty strengths/gaps arrays (every grading must be actionable)", () => {
    const noStrengths = { ...validPayload, strengths: [] };
    expect(recordGradeInputSchema.safeParse(noStrengths).success).toBe(false);
    const noGaps = { ...validPayload, gaps: [] };
    expect(recordGradeInputSchema.safeParse(noGaps).success).toBe(false);
  });

  it("rejects a too-short model_answer — the reference must be substantive", () => {
    const bad = { ...validPayload, model_answer: "Too short." };
    expect(recordGradeInputSchema.safeParse(bad).success).toBe(false);
  });

  it("validateInput returns a validation ToolError (D2.2) on bad input", () => {
    const result = recordGradeTool.validateInput({ foo: "bar" });
    expect(result).toMatchObject({
      isError: true,
      errorCategory: "validation",
      isRetryable: true,
    });
  });

  it("validateInput returns {ok: true, value} on good input", () => {
    const result = recordGradeTool.validateInput(validPayload);
    expect(result).toMatchObject({ ok: true });
  });

  it("has description that differentiates it from sibling tools (D2.1)", () => {
    // Per .claude/rules/tools.md — description must describe when to call,
    // when not to, and what contract the tool enforces.
    expect(recordGradeTool.description).toMatch(/exactly once/i);
    expect(recordGradeTool.description).toMatch(/persist/i);
    expect(recordGradeTool.description.length).toBeGreaterThan(200);
  });
});

describe("emit_rubric tool schema (RD4)", () => {
  const validRubric = {
    criteria: [
      {
        id: "tool_distribution",
        title: "Names correct per-role tool distribution",
        description:
          "The answer must identify which tools go to which role and why the grader cannot see tutor tools (D2.3).",
        weight: 0.5,
        score_anchors: {
          "0": "No mention of per-role tool distribution at all.",
          "3": "Names tool distribution but does not cite D2.3 or give an example.",
          "5": "Names D2.3, gives the grader-vs-tutor example, explains why god-bags are rejected.",
        },
      },
      {
        id: "escalation_triggers",
        title: "Lists the three D5.2 escalation triggers",
        description:
          "The answer must enumerate explicit_ask, three_failed_hints, and policy_gap as the legal escalation causes.",
        weight: 0.3,
        score_anchors: {
          "0": "No escalation discussion at all.",
          "3": "Lists one or two triggers; misses policy_gap.",
          "5": "All three triggers named and distinguished with examples.",
        },
      },
      {
        id: "stop_reason_loop",
        title: "Describes stop_reason-driven loop control",
        description:
          "The answer must state that loop control branches on stop_reason, not on parsed assistant text (D1.1).",
        weight: 0.2,
        score_anchors: {
          "0": "Parses assistant text as a control signal.",
          "3": "Names stop_reason but does not rule out text-parsing.",
          "5": "Names stop_reason as the sole control signal and rules out text-parsing explicitly.",
        },
      },
    ],
  };

  it("accepts a well-formed 3-criterion rubric with weights summing to 1.0", () => {
    const parsed = emitRubricInputSchema.safeParse(validRubric);
    expect(parsed.success).toBe(true);
  });

  it("rejects weights that do not sum to 1.0", () => {
    const bad = {
      criteria: validRubric.criteria.map((c, i) =>
        i === 0 ? { ...c, weight: 0.4 } : c,
      ),
    };
    const parsed = emitRubricInputSchema.safeParse(bad);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((i) => /sum.*1\.0/.test(i.message))).toBe(
        true,
      );
    }
  });

  it("rejects fewer than 3 criteria", () => {
    const bad = { criteria: validRubric.criteria.slice(0, 2) };
    expect(emitRubricInputSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects more than 5 criteria", () => {
    const extra = { ...validRubric.criteria[0] };
    const bad = {
      criteria: [
        { ...extra, id: "a" },
        { ...extra, id: "b" },
        { ...extra, id: "c" },
        { ...extra, id: "d" },
        { ...extra, id: "e" },
        { ...extra, id: "f" },
      ].map((c, _i, arr) => ({ ...c, weight: 1 / arr.length })),
    };
    expect(bad.criteria.length).toBe(6);
    expect(emitRubricInputSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects duplicate criterion ids", () => {
    const bad = {
      criteria: [
        { ...validRubric.criteria[0], weight: 0.5 },
        { ...validRubric.criteria[0], weight: 0.5 },
        { ...validRubric.criteria[2] },
      ],
    };
    // Weights sum to 1.2 here — refine the test to make the duplicate the
    // only real failure.
    const fixed = {
      criteria: [
        { ...validRubric.criteria[0], weight: 0.4 },
        { ...validRubric.criteria[0], weight: 0.4 },
        { ...validRubric.criteria[2], weight: 0.2 },
      ],
    };
    const parsed = emitRubricInputSchema.safeParse(fixed);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(
        parsed.error.issues.some((i) => /unique/.test(i.message)),
      ).toBe(true);
    }
    // The earlier `bad` payload should also fail (weights or uniqueness).
    expect(emitRubricInputSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects invalid criterion id format (not lower_snake_case)", () => {
    const bad = {
      criteria: validRubric.criteria.map((c, i) =>
        i === 0 ? { ...c, id: "Tool-Choice" } : c,
      ),
    };
    expect(emitRubricInputSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects missing score anchors", () => {
    const bad = {
      criteria: validRubric.criteria.map((c, i) =>
        i === 0
          ? {
              ...c,
              score_anchors: { "0": c.score_anchors["0"], "5": c.score_anchors["5"] },
            }
          : c,
      ),
    };
    expect(emitRubricInputSchema.safeParse(bad).success).toBe(false);
  });

  it("validateInput returns a ToolError on bad input (D2.2)", () => {
    const result = emitRubricTool.validateInput({ criteria: [] });
    expect(result).toMatchObject({
      isError: true,
      errorCategory: "validation",
      isRetryable: true,
    });
  });
});
