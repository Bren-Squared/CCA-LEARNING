import { randomUUID } from "node:crypto";
import { type Db, getDb, schema } from "../db";
import type Anthropic from "@anthropic-ai/sdk";

/**
 * Published per-model prices (USD per million tokens). Cache reads are
 * charged at 0.1×, cache writes at 1.25× the base input rate. Unknown
 * models fall through to zero so logging still works.
 */
const MODEL_PRICES: Record<string, { inUsd: number; outUsd: number }> = {
  "claude-sonnet-4-6": { inUsd: 3, outUsd: 15 },
  "claude-opus-4-6": { inUsd: 15, outUsd: 75 },
  "claude-haiku-4-5-20251001": { inUsd: 1, outUsd: 5 },
};

export function estimateCostUsd(
  model: string,
  usage: Pick<
    Anthropic.Usage,
    | "input_tokens"
    | "output_tokens"
    | "cache_creation_input_tokens"
    | "cache_read_input_tokens"
  >,
): number {
  const price = MODEL_PRICES[model];
  if (!price) return 0;
  const inputPrice = price.inUsd / 1_000_000;
  const outputPrice = price.outUsd / 1_000_000;
  const base = (usage.input_tokens ?? 0) * inputPrice;
  const output = usage.output_tokens * outputPrice;
  const cacheWrite =
    (usage.cache_creation_input_tokens ?? 0) * inputPrice * 1.25;
  const cacheRead = (usage.cache_read_input_tokens ?? 0) * inputPrice * 0.1;
  return base + output + cacheWrite + cacheRead;
}

export interface CallLogEntry {
  role: string;
  model: string;
  usage: Anthropic.Usage;
  stopReason: string | null;
  durationMs: number;
}

export function recordCall(entry: CallLogEntry, db: Db = getDb()): void {
  const cost = estimateCostUsd(entry.model, entry.usage);
  db.insert(schema.claudeCallLog)
    .values({
      id: randomUUID(),
      role: entry.role,
      model: entry.model,
      inputTokens: entry.usage.input_tokens ?? 0,
      outputTokens: entry.usage.output_tokens,
      cacheCreationInputTokens: entry.usage.cache_creation_input_tokens ?? 0,
      cacheReadInputTokens: entry.usage.cache_read_input_tokens ?? 0,
      estimatedCostUsd: cost,
      stopReason: entry.stopReason,
      durationMs: entry.durationMs,
    })
    .run();
}
