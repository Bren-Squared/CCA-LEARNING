import { describe, expect, it } from "vitest";
import {
  emitExplainerInputSchema,
  emitExplainerTool,
} from "../lib/claude/roles/explainer";
import { isToolError } from "../lib/claude/tools";

const validInput = {
  narrative_md:
    "This is a long enough narrative body to pass the 200-char minimum. ".repeat(
      5,
    ),
  check_questions: [
    {
      stem: "What is an agentic loop?",
      options: ["A", "B", "C", "D"],
      correct_index: 0,
      explanation:
        "The right answer is A because of reasons. B is wrong because X, C because Y, D because Z.",
      bloom_level: 2,
      bloom_justification: "Tests understanding of the agentic loop concept.",
    },
    {
      stem: "When would you add a stop condition to an agentic loop?",
      options: ["A", "B", "C", "D"],
      correct_index: 2,
      explanation:
        "C is correct for these reasons. A misses the stop_reason check, B conflates tool_use with end_turn, D ignores budget constraints.",
      bloom_level: 3,
      bloom_justification:
        "Applying the stop-reason pattern to a new scenario.",
    },
  ],
};

describe("emit_explainer tool schema", () => {
  it("accepts a well-formed narrative + 2 MCQs", () => {
    const result = emitExplainerTool.validateInput(validInput);
    expect("ok" in result && result.ok).toBe(true);
  });

  it("rejects too-short narrative", () => {
    const bad = { ...validInput, narrative_md: "too short" };
    const result = emitExplainerTool.validateInput(bad);
    expect(isToolError(result)).toBe(true);
    if (isToolError(result)) {
      expect(result.errorCategory).toBe("validation");
      expect(result.message).toMatch(/narrative_md/);
    }
  });

  it("rejects fewer than 2 questions", () => {
    const bad = {
      ...validInput,
      check_questions: [validInput.check_questions[0]],
    };
    const result = emitExplainerTool.validateInput(bad);
    expect(isToolError(result)).toBe(true);
  });

  it("rejects more than 3 questions", () => {
    const bad = {
      ...validInput,
      check_questions: [
        ...validInput.check_questions,
        validInput.check_questions[0],
        validInput.check_questions[1],
      ],
    };
    const result = emitExplainerTool.validateInput(bad);
    expect(isToolError(result)).toBe(true);
  });

  it("rejects option arrays of wrong length", () => {
    const bad = {
      ...validInput,
      check_questions: [
        {
          ...validInput.check_questions[0],
          options: ["A", "B", "C"], // only 3
        },
        validInput.check_questions[1],
      ],
    };
    const result = emitExplainerTool.validateInput(bad);
    expect(isToolError(result)).toBe(true);
  });

  it("rejects out-of-range bloom_level", () => {
    const bad = {
      ...validInput,
      check_questions: [
        { ...validInput.check_questions[0], bloom_level: 7 },
        validInput.check_questions[1],
      ],
    };
    const result = emitExplainerTool.validateInput(bad);
    expect(isToolError(result)).toBe(true);
  });

  it("rejects correct_index outside 0..3", () => {
    const bad = {
      ...validInput,
      check_questions: [
        { ...validInput.check_questions[0], correct_index: 4 },
        validInput.check_questions[1],
      ],
    };
    const result = emitExplainerTool.validateInput(bad);
    expect(isToolError(result)).toBe(true);
  });

  it("exposes a JSON Schema matching Anthropic tool expectations", () => {
    expect(emitExplainerTool.inputSchema.type).toBe("object");
    expect(emitExplainerTool.inputSchema.required).toEqual([
      "narrative_md",
      "check_questions",
    ]);
    // Ensure options minItems/maxItems both pinned at 4
    const checkQ = (
      emitExplainerTool.inputSchema.properties.check_questions as {
        items: { properties: { options: { minItems: number; maxItems: number } } };
      }
    ).items;
    expect(checkQ.properties.options.minItems).toBe(4);
    expect(checkQ.properties.options.maxItems).toBe(4);
  });

  it("the zod schema is the same source of truth", () => {
    const parsed = emitExplainerInputSchema.safeParse(validInput);
    expect(parsed.success).toBe(true);
  });
});
