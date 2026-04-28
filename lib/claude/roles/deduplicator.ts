import { z } from "zod";
import { toolError, type ToolDefinition } from "../tools";
import type { RoleDefinition } from "./types";

/**
 * emit_dedup_verdict — structured output for duplicate question analysis.
 * The deduplicator receives all active question stems in a single
 * (task_statement × bloom_level) cell and groups semantically similar
 * questions. Only groups with 2+ members (actual duplicates) are returned.
 */

const dedupGroupSchema = z.object({
  question_ids: z.array(z.string().min(1)).min(2),
  keep_id: z.string().min(1),
  retire_ids: z.array(z.string().min(1)).min(1),
  reason: z.string().min(5),
});

export const emitDedupVerdictInputSchema = z
  .object({
    groups: z.array(dedupGroupSchema).default([]),
    summary: z.string().min(5),
  })
  .refine(
    (v) =>
      v.groups.every(
        (g) =>
          g.question_ids.includes(g.keep_id) &&
          g.retire_ids.every((id) => g.question_ids.includes(id)) &&
          !g.retire_ids.includes(g.keep_id) &&
          g.retire_ids.length === g.question_ids.length - 1,
      ),
    {
      message:
        "keep_id must be in question_ids; retire_ids must be the remaining question_ids",
    },
  );

export type EmitDedupVerdictInput = z.infer<typeof emitDedupVerdictInputSchema>;

export const emitDedupVerdictTool: ToolDefinition<
  EmitDedupVerdictInput,
  { ok: true }
> = {
  name: "emit_dedup_verdict",
  description:
    "Emits the deduplication verdict for a set of questions within a single (task_statement, bloom_level) cell. Groups semantically similar questions — those that test the same concept, angle, or distinction — into clusters. For each cluster with 2+ members, designate one to keep (prefer seed-sourced, then clearer wording) and the rest to retire. Return an empty groups array if all questions are distinct. Call exactly once per invocation.",
  inputSchema: {
    type: "object",
    properties: {
      groups: {
        type: "array",
        description:
          "Clusters of semantically similar questions. Only include groups with 2+ members.",
        items: {
          type: "object",
          properties: {
            question_ids: {
              type: "array",
              items: { type: "string" },
              minItems: 2,
              description:
                "IDs of all questions in this similarity cluster.",
            },
            keep_id: {
              type: "string",
              description:
                "The single best question to keep. Prefer seed-sourced over generated; prefer clearer wording and more specific stems.",
            },
            retire_ids: {
              type: "array",
              items: { type: "string" },
              minItems: 1,
              description: "IDs to retire (all question_ids except keep_id).",
            },
            reason: {
              type: "string",
              minLength: 5,
              description:
                "Why these questions are duplicates — what shared concept or angle they test.",
            },
          },
          required: ["question_ids", "keep_id", "retire_ids", "reason"],
          additionalProperties: false,
        },
        default: [],
      },
      summary: {
        type: "string",
        minLength: 5,
        description:
          "One-sentence overall assessment (e.g., '3 duplicate groups found, 5 questions recommended for retirement').",
      },
    },
    required: ["groups", "summary"],
    additionalProperties: false,
  },
  validateInput: (raw) => {
    const parsed = emitDedupVerdictInputSchema.safeParse(raw);
    if (!parsed.success) {
      return toolError(
        "validation",
        `emit_dedup_verdict input failed validation: ${parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
        true,
      );
    }
    return { ok: true, value: parsed.data };
  },
  handler: () => ({ ok: true, data: { ok: true } }),
};

export const deduplicatorRole: RoleDefinition = {
  name: "deduplicator",
  description:
    "Analyzes a set of questions within a single (task_statement, bloom_level) cell for semantic duplicates. Groups similar questions and recommends which to keep vs. retire. Emits verdict via emit_dedup_verdict.",
  systemPromptId: "deduplicator.questions",
  cacheSystem: false,
  modelTier: "cheap",
  tools: [emitDedupVerdictTool],
};
