import { describe, expect, it } from "vitest";
import {
  emitQuestionInputSchema,
  emitQuestionTool,
} from "../lib/claude/roles/generator";
import {
  emitReviewInputSchema,
  emitReviewTool,
} from "../lib/claude/roles/reviewer";

function validQuestion() {
  return {
    stem: "Which stop_reason signals tool execution?",
    options: ["end_turn", "tool_use", "max_tokens", "pause_turn"],
    correct_index: 1,
    explanations: [
      "end_turn indicates a normal completion, not a tool call.",
      "tool_use means the model emitted a tool call — the orchestrator must execute it.",
      "max_tokens means the output was truncated before completion.",
      "pause_turn is a streaming-specific pause, not a tool-call signal.",
    ],
    bloom_level: 2,
    bloom_justification: "Recognition of the SDK's stop_reason taxonomy.",
    difficulty: 2,
  };
}

describe("emit_question schema", () => {
  it("accepts a well-formed question", () => {
    const result = emitQuestionInputSchema.safeParse(validQuestion());
    expect(result.success).toBe(true);
  });

  it("rejects questions with fewer than 4 options", () => {
    const result = emitQuestionInputSchema.safeParse({
      ...validQuestion(),
      options: ["a", "b", "c"],
      explanations: ["x", "y", "z"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects correct_index outside [0,3]", () => {
    const result = emitQuestionInputSchema.safeParse({
      ...validQuestion(),
      correct_index: 4,
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing explanations", () => {
    const q = validQuestion() as Record<string, unknown>;
    delete q.explanations;
    expect(emitQuestionInputSchema.safeParse(q).success).toBe(false);
  });

  it("rejects out-of-range bloom_level", () => {
    expect(
      emitQuestionInputSchema.safeParse({ ...validQuestion(), bloom_level: 0 })
        .success,
    ).toBe(false);
    expect(
      emitQuestionInputSchema.safeParse({ ...validQuestion(), bloom_level: 7 })
        .success,
    ).toBe(false);
  });

  it("validateInput surfaces structured validation error (AT12 surface)", () => {
    const bad = { stem: "short" };
    const result = emitQuestionTool.validateInput(bad);
    expect("isError" in result && result.isError).toBe(true);
    if ("isError" in result) {
      expect(result.errorCategory).toBe("validation");
      expect(result.message).toMatch(/emit_question input failed validation/);
    }
  });
});

describe("emit_review schema", () => {
  it("accepts approve with empty violations", () => {
    const result = emitReviewInputSchema.safeParse({
      verdict: "approve",
      summary: "Clear key, plausible distractors.",
    });
    expect(result.success).toBe(true);
  });

  it("rejects approve that carries violations", () => {
    const result = emitReviewInputSchema.safeParse({
      verdict: "approve",
      summary: "Looks fine overall.",
      violations: [{ code: "weak_explanation", detail: "needs work" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects reject with empty violations", () => {
    const result = emitReviewInputSchema.safeParse({
      verdict: "reject",
      summary: "Not good.",
    });
    expect(result.success).toBe(false);
  });

  it("accepts reject with at least one violation", () => {
    const result = emitReviewInputSchema.safeParse({
      verdict: "reject",
      summary: "Key is ambiguous.",
      violations: [
        { code: "ambiguous_stem", detail: "Options A and C both fit." },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown violation codes", () => {
    const result = emitReviewInputSchema.safeParse({
      verdict: "reject",
      summary: "has issues",
      violations: [{ code: "not_a_real_code", detail: "xxxxx" }],
    });
    expect(result.success).toBe(false);
  });

  it("validateInput surfaces structured validation error", () => {
    const result = emitReviewTool.validateInput({ verdict: "maybe" });
    expect("isError" in result && result.isError).toBe(true);
  });
});
