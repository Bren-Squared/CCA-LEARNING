import type { ToolDefinition } from "../tools";

/**
 * A Claude "role" bundles the three things the model needs to do a job:
 * a system prompt template, the exact tool set it's allowed to call, and
 * the preferred model. Narrow tool sets are mandatory per D2.3 — no
 * shared god-bag. Role skeletons live here; handlers for each tool land
 * in the phase that first needs them (generator in Phase 6, tutor in
 * Phase 9, etc.).
 */
export interface RoleDefinition {
  name: string;
  description: string;
  /** Prompt id (resolved via /prompts loader) OR raw system text. */
  systemPromptId?: string;
  systemPromptText?: string;
  /** Whether to mark the system prompt cacheable (NFR4.3). */
  cacheSystem: boolean;
  /** The narrow tool set this role may call. */
  tools: ToolDefinition[];
  /**
   * Model preference. "default" → settings.default_model (sonnet tier);
   * "cheap" → settings.cheap_model (haiku tier, used by reviewer + bulk).
   */
  modelTier: "default" | "cheap";
}
