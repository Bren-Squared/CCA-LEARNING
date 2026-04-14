import { asc, desc, gte, sql } from "drizzle-orm";
import type { Db } from "../db";
import { getAppDb, schema } from "../db";
import { readSettings } from "../settings";

/**
 * Spend summary (FR5.4 / NFR4.2).
 *
 * Reads `claude_call_log` + `settings.token_budget_month_usd` to produce:
 *   - month-to-date cost + call count, broken out by role and model;
 *   - the "current session" — the most recent burst of calls with no gap
 *     greater than {@link SESSION_GAP_MS};
 *   - a `softWarning` flag per NFR4.2 when month-to-date exceeds 80% of
 *     the configured monthly budget.
 *
 * No values here depend on wall-clock time beyond `now`, so tests can pass
 * a fixed timestamp and assert deterministic summaries.
 */

export const SESSION_GAP_MS = 30 * 60_000;
export const SOFT_WARN_RATIO = 0.8;

export interface SpendBreakdownEntry {
  key: string;
  callCount: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

export interface SpendWindow {
  costUsd: number;
  callCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  startedAt: Date | null;
  endedAt: Date | null;
}

export interface SpendSummary {
  monthToDate: SpendWindow & {
    monthStart: Date;
    byRole: SpendBreakdownEntry[];
    byModel: SpendBreakdownEntry[];
  };
  currentSession: SpendWindow;
  budgetMonthUsd: number;
  budgetUsedRatio: number;
  softWarning: boolean;
  recentCalls: Array<{
    id: string;
    ts: Date;
    role: string;
    model: string;
    costUsd: number;
    inputTokens: number;
    outputTokens: number;
    stopReason: string | null;
    durationMs: number;
  }>;
}

function monthStartOf(now: Date): Date {
  // UTC month boundary — keeps server/client math identical regardless of
  // the user's local timezone and makes tests deterministic with ISO inputs.
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function addToBreakdown(
  map: Map<string, SpendBreakdownEntry>,
  key: string,
  row: typeof schema.claudeCallLog.$inferSelect,
): void {
  const prev = map.get(key) ?? {
    key,
    callCount: 0,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
  };
  prev.callCount += 1;
  prev.costUsd += row.estimatedCostUsd;
  prev.inputTokens += row.inputTokens;
  prev.outputTokens += row.outputTokens;
  map.set(key, prev);
}

function sortByCostDesc(entries: SpendBreakdownEntry[]): SpendBreakdownEntry[] {
  return [...entries].sort((a, b) => b.costUsd - a.costUsd);
}

export function computeSpendSummary(
  db: Db = getAppDb(),
  now: Date = new Date(),
  opts: { recentLimit?: number } = {},
): SpendSummary {
  const monthStart = monthStartOf(now);
  const settingsRow = readSettings(db);
  const budget = settingsRow.tokenBudgetMonthUsd;

  const mtdRows = db
    .select()
    .from(schema.claudeCallLog)
    .where(gte(schema.claudeCallLog.ts, monthStart))
    .orderBy(asc(schema.claudeCallLog.ts))
    .all();

  const mtd: SpendWindow = {
    costUsd: 0,
    callCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    startedAt: null,
    endedAt: null,
  };
  const byRole = new Map<string, SpendBreakdownEntry>();
  const byModel = new Map<string, SpendBreakdownEntry>();
  for (const row of mtdRows) {
    mtd.costUsd += row.estimatedCostUsd;
    mtd.callCount += 1;
    mtd.inputTokens += row.inputTokens;
    mtd.outputTokens += row.outputTokens;
    mtd.cacheCreationTokens += row.cacheCreationInputTokens;
    mtd.cacheReadTokens += row.cacheReadInputTokens;
    if (!mtd.startedAt) mtd.startedAt = row.ts;
    mtd.endedAt = row.ts;
    addToBreakdown(byRole, row.role, row);
    addToBreakdown(byModel, row.model, row);
  }

  // Current session — walk backwards, stop the first time we hit a gap greater
  // than SESSION_GAP_MS. The session is everything after that boundary.
  const session: SpendWindow = {
    costUsd: 0,
    callCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    startedAt: null,
    endedAt: null,
  };
  if (mtdRows.length > 0) {
    // We need to walk the whole log (not just MTD) for correctness when the
    // session spans the month boundary. Fetch with one query.
    const allRows = db
      .select()
      .from(schema.claudeCallLog)
      .orderBy(asc(schema.claudeCallLog.ts))
      .all();
    let boundary = 0;
    for (let i = allRows.length - 1; i > 0; i--) {
      const gap = allRows[i].ts.getTime() - allRows[i - 1].ts.getTime();
      if (gap > SESSION_GAP_MS) {
        boundary = i;
        break;
      }
    }
    const sessionRows = allRows.slice(boundary);
    for (const row of sessionRows) {
      session.costUsd += row.estimatedCostUsd;
      session.callCount += 1;
      session.inputTokens += row.inputTokens;
      session.outputTokens += row.outputTokens;
      session.cacheCreationTokens += row.cacheCreationInputTokens;
      session.cacheReadTokens += row.cacheReadInputTokens;
      if (!session.startedAt) session.startedAt = row.ts;
      session.endedAt = row.ts;
    }
  }

  const recentLimit = opts.recentLimit ?? 20;
  const recentRows = db
    .select()
    .from(schema.claudeCallLog)
    .orderBy(desc(schema.claudeCallLog.ts))
    .limit(recentLimit)
    .all();

  const budgetUsedRatio =
    budget > 0 ? mtd.costUsd / budget : mtd.costUsd > 0 ? Infinity : 0;

  return {
    monthToDate: {
      ...mtd,
      monthStart,
      byRole: sortByCostDesc([...byRole.values()]),
      byModel: sortByCostDesc([...byModel.values()]),
    },
    currentSession: session,
    budgetMonthUsd: budget,
    budgetUsedRatio,
    softWarning: budgetUsedRatio >= SOFT_WARN_RATIO,
    recentCalls: recentRows.map((r) => ({
      id: r.id,
      ts: r.ts,
      role: r.role,
      model: r.model,
      costUsd: r.estimatedCostUsd,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      stopReason: r.stopReason,
      durationMs: r.durationMs,
    })),
  };
}

/**
 * Lightweight variant for the home-page banner — we only need the ratio and
 * the warning flag, not the full breakdown, so we avoid the extra queries.
 */
export function readBudgetStatus(
  db: Db = getAppDb(),
  now: Date = new Date(),
): { budgetMonthUsd: number; costMtdUsd: number; ratio: number; softWarning: boolean } {
  const monthStart = monthStartOf(now);
  const row = db
    .select({ cost: sql<number>`coalesce(sum(${schema.claudeCallLog.estimatedCostUsd}), 0)` })
    .from(schema.claudeCallLog)
    .where(gte(schema.claudeCallLog.ts, monthStart))
    .get();
  const costMtdUsd = row?.cost ?? 0;
  const settingsRow = readSettings(db);
  const budget = settingsRow.tokenBudgetMonthUsd;
  const ratio =
    budget > 0 ? costMtdUsd / budget : costMtdUsd > 0 ? Infinity : 0;
  return {
    budgetMonthUsd: budget,
    costMtdUsd,
    ratio,
    softWarning: ratio >= SOFT_WARN_RATIO,
  };
}
