import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { estimateCostUsd, recordCall } from "../lib/claude/tokens";
import type { Db } from "../lib/db";
import { schema } from "../lib/db";

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

describe("estimateCostUsd", () => {
  it("prices sonnet inputs and outputs per published rates", () => {
    const cost = estimateCostUsd("claude-sonnet-4-6", {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
    // 1M in × $3 + 1M out × $15 = $18
    expect(cost).toBeCloseTo(18, 5);
  });

  it("prices cache writes at 1.25× and cache reads at 0.1× of input", () => {
    const cost = estimateCostUsd("claude-sonnet-4-6", {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 1_000_000,
      cache_read_input_tokens: 1_000_000,
    });
    // 1M × $3 × 1.25 + 1M × $3 × 0.1 = $3.75 + $0.30 = $4.05
    expect(cost).toBeCloseTo(4.05, 5);
  });

  it("returns 0 for unknown models rather than crashing", () => {
    expect(
      estimateCostUsd("claude-future-model-xyz", {
        input_tokens: 1000,
        output_tokens: 1000,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      }),
    ).toBe(0);
  });
});

describe("recordCall", () => {
  let handle: ReturnType<typeof freshDb>;
  beforeEach(() => {
    handle = freshDb();
  });

  it("writes a row to claude_call_log with all usage fields", () => {
    recordCall(
      {
        role: "smoke_test",
        model: "claude-sonnet-4-6",
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation: null,
          inference_geo: null,
          server_tool_use: null,
          service_tier: null,
        },
        stopReason: "end_turn",
        durationMs: 321,
      },
      handle.db,
    );
    const rows = handle.db.select().from(schema.claudeCallLog).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].role).toBe("smoke_test");
    expect(rows[0].model).toBe("claude-sonnet-4-6");
    expect(rows[0].inputTokens).toBe(100);
    expect(rows[0].outputTokens).toBe(50);
    expect(rows[0].stopReason).toBe("end_turn");
    expect(rows[0].durationMs).toBe(321);
    expect(rows[0].estimatedCostUsd).toBeGreaterThan(0);
    handle.close();
  });
});
