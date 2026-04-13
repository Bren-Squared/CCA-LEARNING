/**
 * Canonical per-model prices (USD per million tokens). Cache reads are
 * charged at 0.1×, cache writes at 1.25× the base input rate. Unknown
 * models fall through to zero so logging still works.
 */
export const MODEL_PRICES: Record<string, { inUsd: number; outUsd: number }> = {
  "claude-sonnet-4-6": { inUsd: 3, outUsd: 15 },
  "claude-opus-4-6": { inUsd: 15, outUsd: 75 },
  "claude-haiku-4-5-20251001": { inUsd: 1, outUsd: 5 },
};

/**
 * Anthropic Batches API discount vs. sync messages endpoint.
 */
export const BATCH_DISCOUNT = 0.5;

/**
 * Average per-question token usage, calibrated from Phase 6a live smokes.
 * Slightly rounded up so bulk cost projections lean conservative.
 */
export const PER_QUESTION_USAGE = {
  generator: { inputTokens: 2000, outputTokens: 700 },
  reviewer: { inputTokens: 2400, outputTokens: 200 },
} as const;

export function estimateCallCostUsd(
  model: string,
  tokens: { inputTokens: number; outputTokens: number },
  options: { batch?: boolean } = {},
): number {
  const price = MODEL_PRICES[model];
  if (!price) return 0;
  const discount = options.batch ? BATCH_DISCOUNT : 1;
  const input = (tokens.inputTokens * price.inUsd) / 1_000_000;
  const output = (tokens.outputTokens * price.outUsd) / 1_000_000;
  return (input + output) * discount;
}
