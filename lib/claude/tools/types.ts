import { z } from "zod";

/**
 * D2.2 — every tool result payload either carries success data or the
 * mandatory structured error shape. Agent code switches on `errorCategory`:
 *
 *   transient  — retry with backoff (network, 429, 5xx)
 *   validation — the arguments were wrong; fix and retry
 *   business   — a real no, not retryable (coverage rule rejected the ask)
 *   permission — agent isn't allowed; do not retry
 *
 * See .claude/rules/tools.md for the conventions applied to tool definitions
 * that live in this directory.
 */
export const TOOL_ERROR_CATEGORIES = [
  "transient",
  "validation",
  "business",
  "permission",
] as const;

export type ToolErrorCategory = (typeof TOOL_ERROR_CATEGORIES)[number];

export const toolErrorSchema = z.object({
  isError: z.literal(true),
  errorCategory: z.enum(TOOL_ERROR_CATEGORIES),
  isRetryable: z.boolean(),
  message: z.string().min(1),
});

export type ToolError = z.infer<typeof toolErrorSchema>;

export function toolError(
  category: ToolErrorCategory,
  message: string,
  isRetryable?: boolean,
): ToolError {
  return {
    isError: true,
    errorCategory: category,
    isRetryable: isRetryable ?? category === "transient",
    message,
  };
}

/**
 * A single Claude tool definition. `inputSchema` is the JSON Schema the API
 * enforces on the model's call; `handler` runs when the model emits a tool
 * call and must return `{ok: true, data}` or a ToolError.
 */
export interface ToolDefinition<
  Input extends Record<string, unknown> = Record<string, unknown>,
  Output = unknown,
> {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  /**
   * Runtime validator that parses the untrusted model input into the typed
   * Input. Returns a validation ToolError on failure so the model can retry.
   */
  validateInput: (raw: unknown) => { ok: true; value: Input } | ToolError;
  handler: (
    input: Input,
  ) => Promise<{ ok: true; data: Output } | ToolError> | { ok: true; data: Output } | ToolError;
}

export type ToolResult<Output = unknown> =
  | { ok: true; data: Output }
  | ToolError;

export function isToolError(value: unknown): value is ToolError {
  return toolErrorSchema.safeParse(value).success;
}

/**
 * Serialize a tool result into the string body the Claude API expects inside
 * a tool_result content block. Structured errors are returned as JSON so the
 * model can reason about `errorCategory` / `isRetryable`.
 */
export function serializeToolResult(result: ToolResult): string {
  if ("ok" in result && result.ok) {
    return typeof result.data === "string"
      ? result.data
      : JSON.stringify(result.data);
  }
  return JSON.stringify(result);
}
