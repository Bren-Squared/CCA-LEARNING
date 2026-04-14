import { z } from "zod";
import { toolError, type ToolDefinition } from "../tools";
import type { RoleDefinition } from "./types";

/**
 * Rubric-drafter role (RD4 — scenario free-response rubrics are dynamic).
 *
 * One call per prompt: the drafter reads the scenario description, the
 * prompt stem, and the target task statement's Knowledge/Skills bullets,
 * and emits a rubric that the grader will then apply verbatim to every
 * subsequent attempt against that prompt. The rubric is generated ONCE
 * at prompt-creation time and persisted to `scenario_prompts.rubric`.
 *
 * Every criterion MUST include `score_anchors` for 0, 3, and 5 so graders
 * have concrete calibration points (D4.1 — explicit criteria, no "be
 * conservative" hedging). Intermediate scores (1, 2, 4) are interpolated by
 * the grader from the anchor descriptions.
 */

const SCORE_ANCHORS = z.object({
  "0": z.string().min(10, "anchor for 0 must describe a fully absent answer"),
  "3": z
    .string()
    .min(10, "anchor for 3 must describe partial/imperfect meeting of the criterion"),
  "5": z
    .string()
    .min(10, "anchor for 5 must describe an ideal answer against this criterion"),
});

const RUBRIC_CRITERION = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(
      /^[a-z][a-z0-9_]*$/,
      "criterion id must be lower_snake_case so the grader can cite it reliably",
    ),
  title: z.string().min(5).max(120),
  description: z
    .string()
    .min(20, "describe the criterion concretely — what the grader is looking for"),
  weight: z
    .number()
    .min(0.05, "very-low-weight criteria obscure the signal; fold them in or drop them")
    .max(1.0),
  score_anchors: SCORE_ANCHORS,
});

export const emitRubricInputSchema = z
  .object({
    criteria: z
      .array(RUBRIC_CRITERION)
      .min(3, "rubrics with fewer than 3 criteria collapse into a single-axis judgment")
      .max(5, "more than 5 criteria overwhelms the grader and the user"),
  })
  .refine(
    (v) => {
      const total = v.criteria.reduce((a, c) => a + c.weight, 0);
      return Math.abs(total - 1.0) < 1e-6;
    },
    { message: "criterion weights must sum to exactly 1.0" },
  )
  .refine(
    (v) => new Set(v.criteria.map((c) => c.id)).size === v.criteria.length,
    { message: "criterion ids must be unique within the rubric" },
  );

export type EmitRubricInput = z.infer<typeof emitRubricInputSchema>;

export const emitRubricTool: ToolDefinition<EmitRubricInput, { ok: true }> = {
  name: "emit_rubric",
  description:
    "Emits the grading rubric for ONE scenario free-response prompt. Call exactly once per invocation. Produce 3-5 criteria, each weighted (weights MUST sum to 1.0), each with a concrete description and three score anchors (0, 3, 5) that let a grader distinguish outcomes without re-reading the prompt. Criterion ids must be lower_snake_case. Do NOT emit generic criteria ('quality', 'completeness') — every criterion must reference something specific to the task statement's Knowledge/Skills bullets or the scenario context.",
  inputSchema: {
    type: "object",
    properties: {
      criteria: {
        type: "array",
        minItems: 3,
        maxItems: 5,
        items: {
          type: "object",
          properties: {
            id: {
              type: "string",
              pattern: "^[a-z][a-z0-9_]*$",
              minLength: 1,
              maxLength: 64,
            },
            title: { type: "string", minLength: 5, maxLength: 120 },
            description: { type: "string", minLength: 20 },
            weight: { type: "number", minimum: 0.05, maximum: 1.0 },
            score_anchors: {
              type: "object",
              properties: {
                "0": { type: "string", minLength: 10 },
                "3": { type: "string", minLength: 10 },
                "5": { type: "string", minLength: 10 },
              },
              required: ["0", "3", "5"],
              additionalProperties: false,
            },
          },
          required: ["id", "title", "description", "weight", "score_anchors"],
          additionalProperties: false,
        },
      },
    },
    required: ["criteria"],
    additionalProperties: false,
  },
  validateInput: (raw) => {
    const parsed = emitRubricInputSchema.safeParse(raw);
    if (!parsed.success) {
      return toolError(
        "validation",
        `emit_rubric input failed validation: ${parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
        true,
      );
    }
    return { ok: true, value: parsed.data };
  },
  handler: () => ({ ok: true, data: { ok: true } }),
};

export const rubricDrafterRole: RoleDefinition = {
  name: "rubric-drafter",
  description:
    "Drafts the 3-5-criterion rubric for a single scenario free-response prompt. Runs once at prompt-creation time; the rubric is stored and reused for every subsequent grading. One tool: emit_rubric.",
  systemPromptId: "rubric-drafter.scenario",
  cacheSystem: true,
  modelTier: "default",
  tools: [emitRubricTool],
};
