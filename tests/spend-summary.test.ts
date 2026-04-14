import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../lib/db";
import { schema } from "../lib/db";
import {
  SESSION_GAP_MS,
  SOFT_WARN_RATIO,
  computeSpendSummary,
  readBudgetStatus,
} from "../lib/spend/summary";

const DRIZZLE_DIR = resolve(process.cwd(), "drizzle");

function allMigrationsSql(): string {
  return readdirSync(DRIZZLE_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(resolve(DRIZZLE_DIR, f), "utf8"))
    .join("\n");
}

function freshDb(): { db: Db; close: () => void } {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  for (const stmt of allMigrationsSql().split("--> statement-breakpoint")) {
    const sql = stmt.trim();
    if (sql) sqlite.exec(sql);
  }
  return { db: drizzle(sqlite, { schema }), close: () => sqlite.close() };
}

function setBudget(db: Db, usd: number): void {
  db.update(schema.settings)
    .set({ tokenBudgetMonthUsd: usd })
    .run();
}

function logCall(
  db: Db,
  at: Date,
  overrides: Partial<typeof schema.claudeCallLog.$inferInsert> = {},
): void {
  db.insert(schema.claudeCallLog)
    .values({
      id: randomUUID(),
      ts: at,
      role: "tutor",
      model: "claude-sonnet-4-6",
      inputTokens: 100,
      outputTokens: 200,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      estimatedCostUsd: 0.01,
      stopReason: "end_turn",
      durationMs: 1200,
      ...overrides,
    })
    .run();
}

describe("computeSpendSummary", () => {
  let handle: ReturnType<typeof freshDb>;
  beforeEach(() => {
    handle = freshDb();
    // Seed the singleton settings row so readSettings has something to find.
    handle.db.insert(schema.settings).values({ id: 1 }).run();
  });

  it("returns zero totals and no warning on an empty log", () => {
    setBudget(handle.db, 50);
    const s = computeSpendSummary(handle.db, new Date("2026-04-14T12:00:00Z"));
    expect(s.monthToDate.costUsd).toBe(0);
    expect(s.monthToDate.callCount).toBe(0);
    expect(s.currentSession.callCount).toBe(0);
    expect(s.budgetUsedRatio).toBe(0);
    expect(s.softWarning).toBe(false);
    handle.close();
  });

  it("month-to-date excludes calls before the month boundary", () => {
    setBudget(handle.db, 50);
    const now = new Date("2026-04-14T12:00:00Z");
    // March call — should be excluded
    logCall(handle.db, new Date("2026-03-31T23:59:00Z"), {
      estimatedCostUsd: 9.99,
    });
    // April calls — should be included
    logCall(handle.db, new Date("2026-04-01T00:01:00Z"), {
      estimatedCostUsd: 1.23,
    });
    logCall(handle.db, new Date("2026-04-10T10:00:00Z"), {
      estimatedCostUsd: 2.34,
    });

    const s = computeSpendSummary(handle.db, now);
    expect(s.monthToDate.callCount).toBe(2);
    expect(s.monthToDate.costUsd).toBeCloseTo(3.57, 5);
    handle.close();
  });

  it("breaks down cost by role and by model, sorted by cost desc", () => {
    setBudget(handle.db, 50);
    const now = new Date("2026-04-14T12:00:00Z");
    logCall(handle.db, new Date("2026-04-10T10:00:00Z"), {
      role: "tutor",
      model: "claude-sonnet-4-6",
      estimatedCostUsd: 1.0,
    });
    logCall(handle.db, new Date("2026-04-11T10:00:00Z"), {
      role: "generator",
      model: "claude-opus-4-6",
      estimatedCostUsd: 4.0,
    });
    logCall(handle.db, new Date("2026-04-12T10:00:00Z"), {
      role: "tutor",
      model: "claude-sonnet-4-6",
      estimatedCostUsd: 2.0,
    });

    const s = computeSpendSummary(handle.db, now);
    expect(s.monthToDate.byRole.map((e) => e.key)).toEqual([
      "generator", // 4.0
      "tutor", // 3.0
    ]);
    expect(s.monthToDate.byRole[0].costUsd).toBe(4.0);
    expect(s.monthToDate.byModel[0].key).toBe("claude-opus-4-6");
    expect(s.monthToDate.byModel[0].costUsd).toBe(4.0);
    handle.close();
  });

  it("softWarning flips on at SOFT_WARN_RATIO of budget", () => {
    setBudget(handle.db, 10);
    const now = new Date("2026-04-14T12:00:00Z");
    // Just under threshold
    logCall(handle.db, new Date("2026-04-10T10:00:00Z"), {
      estimatedCostUsd: 10 * (SOFT_WARN_RATIO - 0.01),
    });
    expect(computeSpendSummary(handle.db, now).softWarning).toBe(false);

    // Tip over
    logCall(handle.db, new Date("2026-04-11T10:00:00Z"), {
      estimatedCostUsd: 0.2, // total now > 8.0
    });
    expect(computeSpendSummary(handle.db, now).softWarning).toBe(true);
    handle.close();
  });

  it("current session bounded by gaps greater than SESSION_GAP_MS", () => {
    setBudget(handle.db, 50);
    const now = new Date("2026-04-14T18:00:00Z");
    // Old burst (a week ago) — outside the current session
    logCall(handle.db, new Date("2026-04-07T10:00:00Z"), {
      estimatedCostUsd: 0.5,
    });
    logCall(handle.db, new Date("2026-04-07T10:05:00Z"), {
      estimatedCostUsd: 0.5,
    });
    // Current session starts here (gap > 30 min since last call)
    const tGap = new Date("2026-04-14T17:00:00Z");
    logCall(handle.db, tGap, { estimatedCostUsd: 0.3 });
    logCall(handle.db, new Date(tGap.getTime() + 5 * 60_000), {
      estimatedCostUsd: 0.7,
    });
    logCall(handle.db, new Date(tGap.getTime() + 25 * 60_000), {
      estimatedCostUsd: 0.5,
    });

    const s = computeSpendSummary(handle.db, now);
    expect(s.currentSession.callCount).toBe(3);
    expect(s.currentSession.costUsd).toBeCloseTo(1.5, 5);
    expect(s.currentSession.startedAt?.getTime()).toBe(tGap.getTime());
    handle.close();
  });

  it("treats the whole log as one session when all gaps are within the threshold", () => {
    setBudget(handle.db, 50);
    const now = new Date("2026-04-14T18:00:00Z");
    const base = new Date("2026-04-14T16:00:00Z").getTime();
    logCall(handle.db, new Date(base), { estimatedCostUsd: 0.1 });
    logCall(handle.db, new Date(base + 10 * 60_000), { estimatedCostUsd: 0.2 });
    logCall(handle.db, new Date(base + 20 * 60_000), { estimatedCostUsd: 0.3 });

    const s = computeSpendSummary(handle.db, now);
    expect(s.currentSession.callCount).toBe(3);
    expect(s.currentSession.costUsd).toBeCloseTo(0.6, 5);
    handle.close();
  });

  it("recentCalls is capped and ordered newest-first", () => {
    setBudget(handle.db, 50);
    const base = new Date("2026-04-14T10:00:00Z").getTime();
    for (let i = 0; i < 30; i++) {
      logCall(handle.db, new Date(base + i * 1000), {
        estimatedCostUsd: 0.01,
        role: `r${i}`,
      });
    }
    const s = computeSpendSummary(handle.db, new Date(base + 31_000), {
      recentLimit: 5,
    });
    expect(s.recentCalls).toHaveLength(5);
    // Most recent call's seconds-offset is 29
    expect(s.recentCalls[0].role).toBe("r29");
    expect(s.recentCalls[4].role).toBe("r25");
    handle.close();
  });

  it("handles zero-budget case without divide-by-zero", () => {
    setBudget(handle.db, 0);
    logCall(handle.db, new Date("2026-04-10T10:00:00Z"), {
      estimatedCostUsd: 0.5,
    });
    const s = computeSpendSummary(
      handle.db,
      new Date("2026-04-14T12:00:00Z"),
    );
    expect(s.budgetUsedRatio).toBe(Infinity);
    expect(s.softWarning).toBe(true);
    handle.close();
  });

  it("SESSION_GAP_MS constant is 30 minutes", () => {
    expect(SESSION_GAP_MS).toBe(30 * 60_000);
  });
});

describe("readBudgetStatus", () => {
  let handle: ReturnType<typeof freshDb>;
  beforeEach(() => {
    handle = freshDb();
    handle.db.insert(schema.settings).values({ id: 1 }).run();
  });

  it("returns zero/false when nothing has been spent", () => {
    setBudget(handle.db, 50);
    const r = readBudgetStatus(handle.db, new Date("2026-04-14T12:00:00Z"));
    expect(r.costMtdUsd).toBe(0);
    expect(r.softWarning).toBe(false);
    handle.close();
  });

  it("matches computeSpendSummary on MTD cost and soft-warn flag", () => {
    setBudget(handle.db, 10);
    const now = new Date("2026-04-14T12:00:00Z");
    logCall(handle.db, new Date("2026-04-10T10:00:00Z"), {
      estimatedCostUsd: 8.5,
    });
    const full = computeSpendSummary(handle.db, now);
    const cheap = readBudgetStatus(handle.db, now);
    expect(cheap.costMtdUsd).toBeCloseTo(full.monthToDate.costUsd, 5);
    expect(cheap.softWarning).toBe(full.softWarning);
    expect(cheap.softWarning).toBe(true);
    handle.close();
  });
});
