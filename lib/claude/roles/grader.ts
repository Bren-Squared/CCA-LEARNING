import { z } from "zod";
import { toolError, type ToolDefinition } from "../tools";
import type { RoleDefinition } from "./types";

/**
 * Scenario free-response grader (FR2.4 / AT17).
 *
 * The grader runs in an isolated Claude context: the system prompt contains
 * ONLY the scenario description, the prompt text, the rubric, and the user's
 * answer. It sees no tutor transcript, no mastery state, no other study
 * events. The only tool offered is `record_grade` with `tool_choice` forced
 * to it — the API call therefore has a single legal exit: emit one grade.
 *
 * This dogfoods D3.2 (Skill-pattern isolation) on the API side, and AT17
 * verifies the isolation by inspecting the backend log: one tool, and the
 * system prompt does not contain any tutor chat.
 */

const CRITERION_SCORE = z.object({
  id: z
    .string()
    .min(1, "criterion id must match one of the rubric's criteria ids")
    .max(64),
  score: z
    .number()
    .int()
    .min(0, "score_anchor for 0 is the floor")
    .max(5, "score_anchor for 5 is the ceiling"),
  reasoning: z
    .string()
    .min(10, "reasoning must cite evidence from the candidate answer, not just restate the anchor"),
});

export const recordGradeInputSchema = z.object({
  overall_score: z
    .number()
    .min(0)
    .max(5)
    .describe("Weighted composite across criteria; FR2.4 score model is 0-5."),
  per_criterion: z
    .array(CRITERION_SCORE)
    .min(1, "at least one criterion score is required")
    .max(10, "too many criteria — rubric defines 3-5"),
  strengths: z
    .array(z.string().min(5))
    .min(1, "identify at least one concrete strength the answer demonstrated")
    .max(6, "keep feedback actionable — cap at 6 strengths"),
  gaps: z
    .array(z.string().min(5))
    .min(1, "identify at least one concrete gap; an error-free perfect answer still gets 'nothing to improve' as the single gap entry")
    .max(6, "cap at 6 gaps — more and feedback becomes noise"),
  model_answer: z
    .string()
    .min(50, "model answer must be substantive — this is the canonical reference the user learns from")
    .max(6000),
});

export type RecordGradeInput = z.infer<typeof recordGradeInputSchema>;

export const recordGradeTool: ToolDefinition<RecordGradeInput, { ok: true }> = {
  name: "record_grade",
  description:
    "Records the final rubric grade for a scenario free-response attempt. Call this EXACTLY ONCE per grader invocation after fully reasoning through every criterion in the rubric. The overall_score is a weighted 0-5 composite the app stores and plots; per_criterion entries map 1:1 to rubric criterion ids with integer anchor scores 0-5 and a 'reasoning' that cites specific phrases from the candidate answer (not a paraphrase of the rubric anchor). Do NOT call record_grade with speculative content before reading the answer end-to-end. This tool does not grade — it PERSISTS a grade the caller has already produced.",
  inputSchema: {
    type: "object",
    properties: {
      overall_score: { type: "number", minimum: 0, maximum: 5 },
      per_criterion: {
        type: "array",
        minItems: 1,
        maxItems: 10,
        items: {
          type: "object",
          properties: {
            id: { type: "string", minLength: 1, maxLength: 64 },
            score: { type: "integer", minimum: 0, maximum: 5 },
            reasoning: { type: "string", minLength: 10 },
          },
          required: ["id", "score", "reasoning"],
          additionalProperties: false,
        },
      },
      strengths: {
        type: "array",
        minItems: 1,
        maxItems: 6,
        items: { type: "string", minLength: 5 },
      },
      gaps: {
        type: "array",
        minItems: 1,
        maxItems: 6,
        items: { type: "string", minLength: 5 },
      },
      model_answer: { type: "string", minLength: 50, maxLength: 6000 },
    },
    required: [
      "overall_score",
      "per_criterion",
      "strengths",
      "gaps",
      "model_answer",
    ],
    additionalProperties: false,
  },
  validateInput: (raw) => {
    const parsed = recordGradeInputSchema.safeParse(raw);
    if (!parsed.success) {
      return toolError(
        "validation",
        `record_grade input failed validation: ${parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
        true,
      );
    }
    return { ok: true, value: parsed.data };
  },
  // Handler is a no-op — the orchestrator reads validated input off the
  // tool_use block directly and persists the scenario_attempt + progress_event.
  handler: () => ({ ok: true, data: { ok: true } }),
};

export const graderRole: RoleDefinition = {
  name: "grader",
  description:
    "Grades a single free-response answer against a single rubric in a single call. Isolated context: sees ONLY the scenario, prompt, rubric, and user answer. One tool: record_grade.",
  systemPromptId: "grader.scenario",
  cacheSystem: false,
  modelTier: "default",
  tools: [recordGradeTool],
};
