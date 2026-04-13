import { describe, expect, it } from "vitest";
import {
  isToolError,
  serializeToolResult,
  toolError,
  toolErrorSchema,
  TOOL_ERROR_CATEGORIES,
} from "../lib/claude/tools";

describe("tool error shape (FR3.5 / AT19 / D2.2)", () => {
  it("constructs a well-formed error with category-appropriate retry default", () => {
    const e = toolError("transient", "upstream 503");
    expect(e.isError).toBe(true);
    expect(e.errorCategory).toBe("transient");
    expect(e.isRetryable).toBe(true);
    expect(e.message).toBe("upstream 503");
  });

  it("defaults isRetryable to false for non-transient categories", () => {
    for (const category of ["validation", "business", "permission"] as const) {
      const e = toolError(category, `cat=${category}`);
      expect(e.isRetryable).toBe(false);
    }
  });

  it("allows overriding isRetryable explicitly", () => {
    const e = toolError("validation", "bad input", true);
    expect(e.isRetryable).toBe(true);
  });

  it("accepts every declared category and rejects anything else", () => {
    for (const category of TOOL_ERROR_CATEGORIES) {
      expect(
        toolErrorSchema.safeParse({
          isError: true,
          errorCategory: category,
          isRetryable: false,
          message: "x",
        }).success,
      ).toBe(true);
    }
    expect(
      toolErrorSchema.safeParse({
        isError: true,
        errorCategory: "mystery",
        isRetryable: false,
        message: "x",
      }).success,
    ).toBe(false);
  });

  it("rejects malformed tool errors (AT19 precondition)", () => {
    const bad = [
      {}, // missing everything
      { isError: false, errorCategory: "transient", isRetryable: true, message: "x" },
      { isError: true, errorCategory: "transient", isRetryable: "yes", message: "x" },
      { isError: true, errorCategory: "transient", isRetryable: true, message: "" },
      "bare string error",
      null,
    ];
    for (const b of bad) {
      expect(toolErrorSchema.safeParse(b).success).toBe(false);
      expect(isToolError(b)).toBe(false);
    }
  });

  it("isToolError recognizes a well-formed error", () => {
    expect(isToolError(toolError("business", "rule X violated"))).toBe(true);
  });

  it("serializeToolResult emits raw string for string success data", () => {
    expect(serializeToolResult({ ok: true, data: "hi" })).toBe("hi");
  });

  it("serializeToolResult JSON-encodes structured success data", () => {
    expect(serializeToolResult({ ok: true, data: { a: 1 } })).toBe(
      '{"a":1}',
    );
  });

  it("serializeToolResult JSON-encodes errors so the model can reason about them", () => {
    const payload = serializeToolResult(toolError("transient", "nope"));
    const parsed = JSON.parse(payload);
    expect(parsed.isError).toBe(true);
    expect(parsed.errorCategory).toBe("transient");
    expect(parsed.isRetryable).toBe(true);
  });
});
