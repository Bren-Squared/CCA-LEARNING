import { describe, expect, it } from "vitest";
import {
  emitFlashcardsInputSchema,
  emitFlashcardsTool,
} from "../lib/claude/roles/card-writer";

describe("emit_flashcards tool schema", () => {
  const valid = {
    cards: [
      {
        front: "Define: tool_use stop_reason",
        back: "Signals the model emitted a tool call. The caller executes the tool and appends the result before the next message.",
        bloom_level: 1 as const,
      },
      {
        front: "Why cache the system prompt for repeated tutor calls?",
        back: "Cached blocks skip re-tokenization, cutting latency and cost. Cache is scoped to the exact block content.",
        bloom_level: 2 as const,
      },
      {
        front: "What is the default SM-2 ease factor?",
        back: "2.5. Adjusted by ±0.1 or down to a 1.3 floor based on the grade quality.",
        bloom_level: 1 as const,
      },
    ],
  };

  it("accepts a valid 3-card deck", () => {
    const result = emitFlashcardsInputSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it("accepts a 5-card deck at the upper bound", () => {
    const five = {
      cards: [
        ...valid.cards,
        { ...valid.cards[0], front: "Q4 front prompt" },
        { ...valid.cards[1], front: "Q5 front prompt" },
      ],
    };
    const result = emitFlashcardsInputSchema.safeParse(five);
    expect(result.success).toBe(true);
  });

  it("rejects fewer than 3 cards", () => {
    const short = { cards: valid.cards.slice(0, 2) };
    const result = emitFlashcardsInputSchema.safeParse(short);
    expect(result.success).toBe(false);
  });

  it("rejects more than 5 cards", () => {
    const many = {
      cards: [
        ...valid.cards,
        ...valid.cards,
      ],
    };
    const result = emitFlashcardsInputSchema.safeParse(many);
    expect(result.success).toBe(false);
  });

  it("rejects bloom_level outside 1..2", () => {
    const high = {
      cards: [
        ...valid.cards.slice(0, 2),
        { ...valid.cards[0], bloom_level: 3 },
      ],
    };
    const result = emitFlashcardsInputSchema.safeParse(high);
    expect(result.success).toBe(false);
  });

  it("rejects empty front", () => {
    const blank = {
      cards: [
        ...valid.cards.slice(0, 2),
        { ...valid.cards[0], front: "" },
      ],
    };
    const result = emitFlashcardsInputSchema.safeParse(blank);
    expect(result.success).toBe(false);
  });

  it("rejects back that is too short to contain a 'why'", () => {
    const shortBack = {
      cards: [
        ...valid.cards.slice(0, 2),
        { ...valid.cards[0], back: "yes" },
      ],
    };
    const result = emitFlashcardsInputSchema.safeParse(shortBack);
    expect(result.success).toBe(false);
  });

  it("validateInput returns ok for valid input", () => {
    const res = emitFlashcardsTool.validateInput(valid);
    expect("ok" in res && res.ok).toBe(true);
  });

  it("validateInput returns structured ToolError for bad input", () => {
    const res = emitFlashcardsTool.validateInput({ cards: [] });
    expect("isError" in res).toBe(true);
    expect("errorCategory" in res && res.errorCategory).toBe("validation");
  });

  it("JSON Schema mirrors the zod constraints for the API boundary", () => {
    // The tool's inputSchema is typed loosely as Record<string, unknown> for
    // the properties bag — cast to the known shape for this parity check.
    const cards = emitFlashcardsTool.inputSchema.properties.cards as {
      minItems: number;
      maxItems: number;
      items: {
        properties: { bloom_level: { maximum: number } };
      };
    };
    expect(cards.minItems).toBe(3);
    expect(cards.maxItems).toBe(5);
    expect(cards.items.properties.bloom_level.maximum).toBe(2);
  });
});
