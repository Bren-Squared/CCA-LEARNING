import { randomUUID } from "node:crypto";
import { type Db, getDb, schema } from "../db";
import type Anthropic from "@anthropic-ai/sdk";
import { BATCH_DISCOUNT, MODEL_PRICES } from "./pricing";

export function estimateCostUsd(
  model: string,
  usage: Pick<
    Anthropic.Usage,
    | "input_tokens"
    | "output_tokens"
    | "cache_creation_input_tokens"
    | "cache_read_input_tokens"
  >,
  options: { batch?: boolean } = {},
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
  const subtotal = base + output + cacheWrite + cacheRead;
  return options.batch ? subtotal * BATCH_DISCOUNT : subtotal;
}

export interface CallLogEntry {
  role: string;
  model: string;
  usage: Anthropic.Usage;
  stopReason: string | null;
  durationMs: number;
  batch?: boolean;
}

export function recordCall(entry: CallLogEntry, db: Db = getDb()): void {
  const cost = estimateCostUsd(entry.model, entry.usage, {
    batch: entry.batch,
  });
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
