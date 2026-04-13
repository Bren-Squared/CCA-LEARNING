import { z } from "zod";
import { toolError, type ToolDefinition } from "../tools";
import type { RoleDefinition } from "./types";

/**
 * emit_question — the generator role's single artifact channel. One MCQ per
 * invocation. Not callable outside the generator role; do not widen into the
 * reviewer or tutor sets (D2.3). The orchestrator reads validated input off
 * the tool_use block and either persists it (after reviewer approval) or
 * feeds it to the reviewer as a candidate.
 */
export const emitQuestionInputSchema = z.object({
  stem: z
    .string()
    .min(10, "stem must give the model enough context to answer")
    .max(1200, "stem is too long for an exam-style MCQ"),
  options: z
    .array(z.string().min(1, "options cannot be empty strings"))
    .length(4, "exam-style MCQs have exactly four options"),
  correct_index: z.number().int().min(0).max(3),
  explanations: z
    .array(z.string().min(10, "each explanation must justify its option"))
    .length(4, "provide an explanation for every option, including distractors"),
  bloom_level: z
    .number()
    .int()
    .min(1)
    .max(6)
    .describe("1=Remember, 2=Understand, 3=Apply, 4=Analyze, 5=Evaluate, 6=Create"),
  bloom_justification: z.string().min(10),
  difficulty: z
    .number()
    .int()
    .min(1)
    .max(5)
    .describe("1=trivial recall, 5=multi-step reasoning"),
});

export type EmitQuestionInput = z.infer<typeof emitQuestionInputSchema>;

export const emitQuestionTool: ToolDefinition<EmitQuestionInput, { ok: true }> = {
  name: "emit_question",
  description:
    "Emits ONE exam-practice MCQ for a specific (task_statement, bloom_level) pair. Call exactly once per invocation. Every option needs an explanation — including distractors, which must name why the distractor is wrong, not just why the key is right. correct_index is 0-based; bloom_level and difficulty are integers within their declared ranges. Do NOT fabricate product names, API shapes, or terminology absent from the task statement's knowledge/skills bullets.",
  inputSchema: {
    type: "object",
    properties: {
      stem: { type: "string", minLength: 10 },
      options: {
        type: "array",
        minItems: 4,
        maxItems: 4,
        items: { type: "string", minLength: 1 },
      },
      correct_index: { type: "integer", minimum: 0, maximum: 3 },
      explanations: {
        type: "array",
        minItems: 4,
        maxItems: 4,
        items: { type: "string", minLength: 10 },
        description:
          "Parallel to options — explanations[i] explains why options[i] is correct or, for distractors, why it is wrong.",
      },
      bloom_level: { type: "integer", minimum: 1, maximum: 6 },
      bloom_justification: { type: "string", minLength: 10 },
      difficulty: { type: "integer", minimum: 1, maximum: 5 },
    },
    required: [
      "stem",
      "options",
      "correct_index",
      "explanations",
      "bloom_level",
      "bloom_justification",
      "difficulty",
    ],
    additionalProperties: false,
  },
  validateInput: (raw) => {
    const parsed = emitQuestionInputSchema.safeParse(raw);
    if (!parsed.success) {
      return toolError(
        "validation",
        `emit_question input failed validation: ${parsed.error.issues
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
 * Generator role — authors ONE new MCQ per invocation for a (task_statement,
 * bloom_level) pair, optionally anchored to a scenario. Uses a coordinator-
 * style prompt that walks through scenario framing, key identification,
 * distractor construction, and Bloom calibration before emitting via
 * emit_question. Few-shot examples (seed questions from the same scenario
 * when available) are added to the message stream by the orchestrator.
 */
export const generatorRole: RoleDefinition = {
  name: "generator",
  description:
    "Generates one new MCQ per invocation for a given (task_statement, bloom_level, optional scenario). Must emit via emit_question; string output is rejected.",
  systemPromptId: "generator.question",
  cacheSystem: true,
  modelTier: "default",
  tools: [emitQuestionTool],
};
