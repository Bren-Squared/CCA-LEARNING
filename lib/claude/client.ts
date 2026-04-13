import Anthropic from "@anthropic-ai/sdk";
import { getApiKey, getDefaultModel } from "../settings";
import { recordCall } from "./tokens";
import type { Db } from "../db";

/**
 * Thrown when no API key is configured. Callers catch this and route the
 * user to /settings rather than leaking the raw error to the UI.
 */
export class NoApiKeyError extends Error {
  readonly code = "no_api_key" as const;
  constructor() {
    super("No Anthropic API key configured. Open /settings to add one.");
    this.name = "NoApiKeyError";
  }
}

let _cachedClient: { key: string; client: Anthropic } | null = null;

function getClient(db?: Db): Anthropic {
  const key = getApiKey(db);
  if (!key) throw new NoApiKeyError();
  if (_cachedClient && _cachedClient.key === key) return _cachedClient.client;
  const client = new Anthropic({ apiKey: key });
  _cachedClient = { key, client };
  return client;
}

export function __resetClientCacheForTests(): void {
  _cachedClient = null;
}

export interface CallClaudeParams {
  /** Role tag for logging + analytics (e.g. "tutor", "grader"). */
  role: string;
  /** Model override; falls back to settings.default_model. */
  model?: string;
  /**
   * System prompt. Pass an array of content blocks if you want to mark
   * specific blocks as cacheable (NFR4.3 / prompt_caching).
   */
  system?: string | Anthropic.TextBlockParam[];
  /**
   * When true, stamps `cache_control: { type: "ephemeral" }` onto the last
   * content block of the system prompt. Use for stable, reusable system
   * context (the ingested guide, few-shot examples).
   */
  cacheSystem?: boolean;
  messages: Anthropic.MessageParam[];
  tools?: Anthropic.Tool[];
  toolChoice?: Anthropic.ToolChoice;
  maxTokens?: number;
  temperature?: number;
  db?: Db;
}

function buildSystem(
  system: CallClaudeParams["system"],
  cacheSystem: boolean,
): Anthropic.TextBlockParam[] | string | undefined {
  if (system === undefined) return undefined;
  if (!cacheSystem) return system;
  const blocks: Anthropic.TextBlockParam[] =
    typeof system === "string" ? [{ type: "text", text: system }] : [...system];
  if (blocks.length === 0) return undefined;
  const last = blocks[blocks.length - 1];
  blocks[blocks.length - 1] = {
    ...last,
    cache_control: { type: "ephemeral" },
  };
  return blocks;
}

export async function callClaude(
  params: CallClaudeParams,
): Promise<Anthropic.Message> {
  const client = getClient(params.db);
  const model = params.model ?? getDefaultModel(params.db);
  const system = buildSystem(params.system, params.cacheSystem ?? false);
  const started = Date.now();
  const response = await client.messages.create({
    model,
    max_tokens: params.maxTokens ?? 2048,
    ...(system !== undefined ? { system } : {}),
    messages: params.messages,
    ...(params.tools ? { tools: params.tools } : {}),
    ...(params.toolChoice ? { tool_choice: params.toolChoice } : {}),
    ...(params.temperature !== undefined
      ? { temperature: params.temperature }
      : {}),
  });
  const durationMs = Date.now() - started;
  try {
    recordCall(
      {
        role: params.role,
        model,
        usage: response.usage,
        stopReason: response.stop_reason,
        durationMs,
      },
      params.db,
    );
  } catch (err) {
    // Logging failure must never bubble up — the call succeeded.
    console.warn(
      "claude_call_log insert failed:",
      err instanceof Error ? err.message : err,
    );
  }
  return response;
}

/**
 * Convenience — pulls the first text block out of an assistant message.
 * Roles that expect structured output should inspect `content` directly.
 */
export function firstText(message: Anthropic.Message): string {
  for (const block of message.content) {
    if (block.type === "text") return block.text;
  }
  return "";
}
