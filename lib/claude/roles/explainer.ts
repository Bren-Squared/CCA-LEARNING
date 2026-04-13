import { z } from "zod";
import { toolError, type ToolDefinition } from "../tools";
import type { RoleDefinition } from "./types";

/**
 * emit_explainer — the explainer role's single artifact channel. The model
 * MUST call this tool exactly once with the full narrative + 2-3 check MCQs.
 * Not callable outside the explainer role; do not widen into the tutor or
 * generator sets (D2.3). The narrative is cached on task_statements; the MCQs
 * are persisted into the questions table with source='generated' so Phase 5's
 * drill automatically picks them up.
 */
export const emitExplainerInputSchema = z.object({
  narrative_md: z.string().min(200, "narrative is too short to be useful"),
  check_questions: z
    .array(
      z.object({
        stem: z.string().min(10),
        options: z.array(z.string().min(1)).length(4),
        correct_index: z.number().int().min(0).max(3),
        explanation: z.string().min(20),
        bloom_level: z.number().int().min(1).max(6),
        bloom_justification: z.string().min(10),
      }),
    )
    .min(2)
    .max(3),
});

export type EmitExplainerInput = z.infer<typeof emitExplainerInputSchema>;

export const emitExplainerTool: ToolDefinition<EmitExplainerInput, { ok: true }> = {
  name: "emit_explainer",
  description:
    "Emits the study narrative and its 2-3 comprehension check MCQs for ONE task statement. Call exactly once per invocation. The narrative is user-facing Markdown (600-1000 words). Each MCQ must have 4 options, 1 correct_index (0-3), an explanation covering all distractors, and a bloom_level in 1-6 with a one-sentence justification. Do NOT call this tool with fewer than 2 questions or more than 3. Do NOT fabricate terminology absent from the provided bullets.",
  inputSchema: {
    type: "object",
    properties: {
      narrative_md: {
        type: "string",
        description:
          "Markdown body of the narrative. 600-1000 words. Use ## headings, fenced code blocks for snippets, inline backticks for identifiers.",
      },
      check_questions: {
        type: "array",
        minItems: 2,
        maxItems: 3,
        items: {
          type: "object",
          properties: {
            stem: { type: "string" },
            options: {
              type: "array",
              minItems: 4,
              maxItems: 4,
              items: { type: "string" },
            },
            correct_index: { type: "integer", minimum: 0, maximum: 3 },
            explanation: { type: "string" },
            bloom_level: { type: "integer", minimum: 1, maximum: 6 },
            bloom_justification: { type: "string" },
          },
          required: [
            "stem",
            "options",
            "correct_index",
            "explanation",
            "bloom_level",
            "bloom_justification",
          ],
          additionalProperties: false,
        },
      },
    },
    required: ["narrative_md", "check_questions"],
    additionalProperties: false,
  },
  validateInput: (raw) => {
    const parsed = emitExplainerInputSchema.safeParse(raw);
    if (!parsed.success) {
      return toolError(
        "validation",
        `emit_explainer input failed validation: ${parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
        true,
      );
    }
    return { ok: true, value: parsed.data };
  },
  // Handler is a no-op — the orchestrator reads validated input off the
  // tool_use block directly and persists. Returning ok keeps the agentic
  // loop happy if we ever run this through one.
  handler: () => ({ ok: true, data: { ok: true } }),
};

/**
 * The explainer role. System prompt is loaded from prompts/explainer.md by the
 * orchestrator at call time (not embedded here — keeping prompt authoring in
 * the /prompts directory so it can be tuned without touching TS).
 */
export const explainerRole: RoleDefinition = {
  name: "explainer",
  description:
    "Writes a study narrative for one task statement plus 2-3 comprehension MCQs. Narrative preserves verbatim exam-guide wording when quoting Knowledge/Skills bullets (DO-NOT #6). One tool: emit_explainer.",
  systemPromptId: "explainer.narrative",
  cacheSystem: true,
  modelTier: "default",
  tools: [emitExplainerTool],
};
