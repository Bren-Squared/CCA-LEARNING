import { z } from "zod";
import { toolError, type ToolDefinition } from "../tools";
import type { RoleDefinition } from "./types";

/**
 * emit_flashcards — the card-writer role's single artifact channel. The model
 * MUST call this tool exactly once with a batch of 3–5 cards for ONE task
 * statement. Not callable outside the card-writer role; do not widen into the
 * tutor or generator sets (D2.3). Every card is tagged Bloom 1 (Remember) or
 * Bloom 2 (Understand) — flashcards target recall and comprehension (per
 * spec.md FR2 modality matrix). Anything beyond L2 belongs in MCQs.
 */
export const emitFlashcardsInputSchema = z.object({
  cards: z
    .array(
      z.object({
        front: z
          .string()
          .min(4, "front must be a real prompt, not a placeholder")
          .max(400, "front is too long for a flashcard — break it up"),
        back: z
          .string()
          .min(10, "back must include the answer + a 1-2 sentence 'why'")
          .max(800, "back is too long — move detail to the explainer"),
        bloom_level: z
          .number()
          .int()
          .min(1)
          .max(2)
          .describe("1=Remember (recall terminology/facts), 2=Understand (paraphrase/explain)"),
      }),
    )
    .min(3, "batch too small — cards per task statement must cover the knowledge bullets")
    .max(5, "batch too large — keep each generation call focused"),
});

export type EmitFlashcardsInput = z.infer<typeof emitFlashcardsInputSchema>;

export const emitFlashcardsTool: ToolDefinition<EmitFlashcardsInput, { ok: true }> = {
  name: "emit_flashcards",
  description:
    "Emits a batch of 3-5 flashcards for ONE task statement. Call exactly once per invocation. Each card has a short `front` prompt (concept / code snippet / scenario fragment) and a `back` with the canonical answer plus a 1-2 sentence 'why'. `bloom_level` is 1 (Remember) or 2 (Understand) — flashcards DO NOT test Apply or higher (that's MCQ territory). Do NOT fabricate terminology absent from the provided knowledge/skills bullets.",
  inputSchema: {
    type: "object",
    properties: {
      cards: {
        type: "array",
        minItems: 3,
        maxItems: 5,
        items: {
          type: "object",
          properties: {
            front: { type: "string", minLength: 4, maxLength: 400 },
            back: { type: "string", minLength: 10, maxLength: 800 },
            bloom_level: { type: "integer", minimum: 1, maximum: 2 },
          },
          required: ["front", "back", "bloom_level"],
          additionalProperties: false,
        },
      },
    },
    required: ["cards"],
    additionalProperties: false,
  },
  validateInput: (raw) => {
    const parsed = emitFlashcardsInputSchema.safeParse(raw);
    if (!parsed.success) {
      return toolError(
        "validation",
        `emit_flashcards input failed validation: ${parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
        true,
      );
    }
    return { ok: true, value: parsed.data };
  },
  // Handler is a no-op — the orchestrator reads validated input off the
  // tool_use block directly and persists.
  handler: () => ({ ok: true, data: { ok: true } }),
};

/**
 * Card-writer role. Authors a fresh deck of 3–5 flashcards for one task
 * statement at Bloom 1–2. System prompt is loaded from prompts/card-writer.md
 * at call time (NFR6.2 — prompts live outside TS). One tool: emit_flashcards.
 */
export const cardWriterRole: RoleDefinition = {
  name: "card-writer",
  description:
    "Writes a small deck of 3-5 flashcards for one task statement at Bloom 1-2. Front is a short prompt, back is the canonical answer + a 1-2 sentence 'why'. One tool: emit_flashcards.",
  systemPromptId: "card-writer.deck",
  cacheSystem: true,
  modelTier: "default",
  tools: [emitFlashcardsTool],
};
