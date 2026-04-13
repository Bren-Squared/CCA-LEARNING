import { z } from "zod";
import { toolError, type ToolDefinition } from "../tools";
import type { RoleDefinition } from "./types";

/**
 * emit_review — the reviewer's verdict channel. Runs in a fresh context with
 * no generator state (D4.6 / AT12). Reviewer sees only the candidate MCQ
 * payload and the task-statement brief, and must issue a single pass/fail
 * with structured feedback the orchestrator can feed back into a retry.
 */
export const REVIEW_VIOLATION_CODES = [
  "wrong_key", // the correct_index does not identify a single best answer
  "ambiguous_stem", // stem admits more than one defensible answer
  "implausible_distractor", // at least one distractor is nonsensical / out-of-domain
  "weak_explanation", // explanations don't justify the key or name distractor faults
  "bloom_mismatch", // bloom_level does not match what the question actually tests
  "fabricated_content", // stem/options cite terminology absent from the bullets
  "other",
] as const;

export const emitReviewInputSchema = z
  .object({
    verdict: z.enum(["approve", "reject"]),
    summary: z.string().min(10),
    violations: z
      .array(
        z.object({
          code: z.enum(REVIEW_VIOLATION_CODES),
          detail: z.string().min(5),
        }),
      )
      .default([]),
    suggestions: z.array(z.string().min(5)).default([]),
  })
  .refine(
    (v) => (v.verdict === "approve" ? v.violations.length === 0 : v.violations.length > 0),
    {
      message:
        "approve verdicts must have no violations; reject verdicts must have at least one",
    },
  );

export type EmitReviewInput = z.infer<typeof emitReviewInputSchema>;

export const emitReviewTool: ToolDefinition<EmitReviewInput, { ok: true }> = {
  name: "emit_review",
  description:
    "Issues the final pass/fail verdict on ONE candidate MCQ. Call exactly once per invocation. On 'reject', include at least one violation with a specific code and a concrete detail the author can act on (not a generic 'looks wrong'). On 'approve', the violations array must be empty. Suggestions are optional concrete edits (e.g., 'replace distractor B with <x> to avoid being out-of-domain').",
  inputSchema: {
    type: "object",
    properties: {
      verdict: { type: "string", enum: ["approve", "reject"] },
      summary: {
        type: "string",
        minLength: 10,
        description: "One- or two-sentence overall judgment.",
      },
      violations: {
        type: "array",
        items: {
          type: "object",
          properties: {
            code: { type: "string", enum: [...REVIEW_VIOLATION_CODES] },
            detail: { type: "string", minLength: 5 },
          },
          required: ["code", "detail"],
          additionalProperties: false,
        },
        default: [],
      },
      suggestions: {
        type: "array",
        items: { type: "string", minLength: 5 },
        default: [],
      },
    },
    required: ["verdict", "summary"],
    additionalProperties: false,
  },
  validateInput: (raw) => {
    const parsed = emitReviewInputSchema.safeParse(raw);
    if (!parsed.success) {
      return toolError(
        "validation",
        `emit_review input failed validation: ${parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
        true,
      );
    }
    return { ok: true, value: parsed.data };
  },
  handler: () => ({ ok: true, data: { ok: true } }),
};

/**
 * Reviewer role — runs in isolated context on the cheap tier (D4.6 / AT12).
 * The reviewer sees ONLY the candidate MCQ payload + a re-statement of the
 * task statement's knowledge/skills bullets. It does not see the generator's
 * scratchpad, few-shot, or prior retry attempts — independence is the point.
 */
export const reviewerRole: RoleDefinition = {
  name: "reviewer",
  description:
    "Reviews a single candidate MCQ for single-answer correctness, plausible distractors, Bloom-level accuracy, and freedom from fabricated content. Emits pass/fail via emit_review.",
  systemPromptId: "reviewer.mcq",
  cacheSystem: false,
  modelTier: "cheap",
  tools: [emitReviewTool],
};
