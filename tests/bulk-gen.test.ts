import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import type { Db } from "../lib/db";
import { schema } from "../lib/db";

// Mock Claude client BEFORE importing the modules under test so the
// reviewer call inside processBulkJob picks up the stub.
const callClaudeMock = vi.fn();
vi.mock("../lib/claude/client", async () => {
  const actual = await vi.importActual<typeof import("../lib/claude/client")>(
    "../lib/claude/client",
  );
  return { ...actual, callClaude: callClaudeMock };
});

const {
  BulkGenError,
  MAX_BULK_N,
  createBulkJob,
  listBulkJobs,
  processBulkJob,
  projectBulkCost,
  refreshBulkJob,
} = await import("../lib/study/bulk-gen");

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

function seedCurriculum(db: Db): void {
  db.insert(schema.domains)
    .values({ id: "D1", title: "Domain 1", weightBps: 5000, orderIndex: 1 })
    .run();
  db.insert(schema.taskStatements)
    .values([
      {
        id: "TS1",
        domainId: "D1",
        title: "Design agentic loops",
        knowledgeBullets: ["Stop reasons"],
        skillsBullets: ["Budget guards"],
        orderIndex: 1,
      },
      {
        id: "TS2",
        domainId: "D1",
        title: "Tool design",
        knowledgeBullets: ["Tool schemas"],
        skillsBullets: ["Error shape"],
        orderIndex: 2,
      },
      {
        id: "TS3",
        domainId: "D1",
        title: "Prompt caching",
        knowledgeBullets: ["Cache breakpoints"],
        skillsBullets: ["Cost impact"],
        orderIndex: 3,
      },
    ])
    .run();
}

function fillAllCellsForTs(db: Db, taskStatementId: string): void {
  let counter = 0;
  for (let level = 1; level <= 5; level++) {
    for (let i = 0; i < 5; i++) {
      counter++;
      db.insert(schema.questions)
        .values({
          id: `seed-${taskStatementId}-${level}-${counter}`,
          taskStatementId,
          stem: "seed stem",
          options: ["a", "b", "c", "d"],
          correctIndex: 0,
          explanations: ["ok", "ok", "ok", "ok"],
          difficulty: 2,
          bloomLevel: level,
          bloomJustification: "seed",
          source: "seed",
          status: "active",
        })
        .run();
    }
  }
}

function goodQuestionInput() {
  return {
    stem: "Which stop_reason indicates a tool invocation in the SDK?",
    options: ["end_turn", "tool_use", "max_tokens", "pause_turn"],
    correct_index: 1,
    explanations: [
      "end_turn means normal completion, not a tool call.",
      "tool_use is the stop_reason the SDK returns for tool calls.",
      "max_tokens means output was truncated, not a tool call.",
      "pause_turn is a streaming pause, not a tool-call signal.",
    ],
    bloom_level: 2,
    bloom_justification: "Recognition-level recall of the SDK's stop_reason set.",
    difficulty: 2,
  };
}

function batchMessage(input: unknown): Anthropic.Messages.Message {
  return {
    id: "msg_batch",
    type: "message",
    role: "assistant",
    model: "claude-opus-4-6",
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: {
      input_tokens: 1800,
      output_tokens: 600,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation: null,
      inference_geo: null,
      server_tool_use: null,
      service_tier: null,
    },
    content: [
      {
        type: "tool_use",
        id: "tu_q",
        name: "emit_question",
        input,
      } as unknown as Anthropic.Messages.ContentBlock,
    ],
  } as unknown as Anthropic.Messages.Message;
}

function reviewMessage(input: unknown) {
  return {
    id: "msg_rev",
    type: "message" as const,
    role: "assistant" as const,
    model: "claude-haiku-4-5-20251001",
    stop_reason: "tool_use" as const,
    stop_sequence: null,
    usage: {
      input_tokens: 80,
      output_tokens: 120,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation: null,
      inference_geo: null,
      server_tool_use: null,
      service_tier: null,
    },
    content: [
      {
        type: "tool_use" as const,
        id: "tu_r",
        name: "emit_review",
        input,
      },
    ],
  };
}

interface BatchStub {
  create: ReturnType<typeof vi.fn>;
  retrieve: ReturnType<typeof vi.fn>;
  results: ReturnType<typeof vi.fn>;
}

function makeStubClient(overrides: Partial<BatchStub> = {}): {
  client: Anthropic;
  batches: BatchStub;
} {
  const batches: BatchStub = {
    create: vi.fn().mockResolvedValue({
      id: "batch_abc",
      processing_status: "in_progress",
      ended_at: null,
      request_counts: {
        processing: 1,
        succeeded: 0,
        errored: 0,
        canceled: 0,
        expired: 0,
      },
    }),
    retrieve: vi.fn().mockResolvedValue({
      id: "batch_abc",
      processing_status: "in_progress",
      ended_at: null,
      request_counts: {
        processing: 1,
        succeeded: 0,
        errored: 0,
        canceled: 0,
        expired: 0,
      },
    }),
    results: vi.fn().mockImplementation(async function* () {
      // default yields nothing
    }),
    ...overrides,
  };
  const client = {
    messages: { batches },
  } as unknown as Anthropic;
  return { client, batches };
}

describe("projectBulkCost", () => {
  let handle: ReturnType<typeof freshDb>;
  beforeEach(() => {
    handle = freshDb();
    seedCurriculum(handle.db);
  });

  it("scales cost linearly with target count", () => {
    const one = projectBulkCost(
      [{ taskStatementId: "TS1", bloomLevel: 2 }],
      handle.db,
    );
    const ten = projectBulkCost(
      Array.from({ length: 10 }, () => ({
        taskStatementId: "TS1",
        bloomLevel: 2 as const,
      })),
      handle.db,
    );
    expect(ten.projectedCostUsd).toBeCloseTo(one.projectedCostUsd * 10, 6);
    expect(ten.targetCount).toBe(10);
    handle.close();
  });

  it("includes both generator (batched) and reviewer (sync) cost", () => {
    const projection = projectBulkCost(
      [{ taskStatementId: "TS1", bloomLevel: 2 }],
      handle.db,
    );
    // Opus 4.6 batch + haiku sync per-question: > $0 and < $1 for one question.
    expect(projection.projectedCostUsd).toBeGreaterThan(0);
    expect(projection.projectedCostUsd).toBeLessThan(1);
    expect(projection.projectedCostCents).toBeGreaterThan(0);
    expect(projection.generatorModel).toMatch(/opus|sonnet/);
    expect(projection.reviewerModel).toMatch(/haiku/);
    handle.close();
  });

  it("flags exceedsCeiling based on settings", () => {
    // Default ceiling is $1.0. A 100-target projection clears that easily.
    const big = projectBulkCost(
      Array.from({ length: 100 }, () => ({
        taskStatementId: "TS1",
        bloomLevel: 3 as const,
      })),
      handle.db,
    );
    expect(big.exceedsCeiling).toBe(true);
    const small = projectBulkCost(
      [{ taskStatementId: "TS1", bloomLevel: 3 }],
      handle.db,
    );
    expect(small.exceedsCeiling).toBe(false);
    handle.close();
  });
});

describe("createBulkJob", () => {
  let handle: ReturnType<typeof freshDb>;
  beforeEach(() => {
    handle = freshDb();
    seedCurriculum(handle.db);
    callClaudeMock.mockReset();
  });

  it("rejects bad_n out of range", async () => {
    const stub = makeStubClient();
    await expect(
      createBulkJob({ n: 0, db: handle.db, client: stub.client }),
    ).rejects.toMatchObject({ code: "bad_n" });
    await expect(
      createBulkJob({
        n: MAX_BULK_N + 1,
        db: handle.db,
        client: stub.client,
      }),
    ).rejects.toMatchObject({ code: "bad_n" });
    expect(stub.batches.create).not.toHaveBeenCalled();
    handle.close();
  });

  it("rejects no_gaps when coverage is full", async () => {
    fillAllCellsForTs(handle.db, "TS1");
    fillAllCellsForTs(handle.db, "TS2");
    fillAllCellsForTs(handle.db, "TS3");
    const stub = makeStubClient();
    await expect(
      createBulkJob({ n: 5, db: handle.db, client: stub.client }),
    ).rejects.toMatchObject({ code: "no_gaps" });
    expect(stub.batches.create).not.toHaveBeenCalled();
    handle.close();
  });

  it("rejects over_ceiling when projection exceeds limit and confirm is not set", async () => {
    // Drop the ceiling below the cost of a single target so any N trips it.
    handle.db
      .insert(schema.settings)
      .values({ id: 1, bulkCostCeilingUsd: 0.001 })
      .onConflictDoUpdate({
        target: schema.settings.id,
        set: { bulkCostCeilingUsd: 0.001 },
      })
      .run();
    const stub = makeStubClient();
    await expect(
      createBulkJob({ n: 5, db: handle.db, client: stub.client }),
    ).rejects.toMatchObject({ code: "over_ceiling" });
    expect(stub.batches.create).not.toHaveBeenCalled();
    handle.close();
  });

  it("bypasses the ceiling when confirm is true", async () => {
    handle.db
      .insert(schema.settings)
      .values({ id: 1, bulkCostCeilingUsd: 0.001 })
      .onConflictDoUpdate({
        target: schema.settings.id,
        set: { bulkCostCeilingUsd: 0.001 },
      })
      .run();
    const stub = makeStubClient();
    const result = await createBulkJob({
      n: 5,
      confirm: true,
      db: handle.db,
      client: stub.client,
    });
    expect(result.jobId).toBeDefined();
    expect(result.anthropicBatchId).toBe("batch_abc");
    expect(stub.batches.create).toHaveBeenCalledOnce();
    const row = handle.db
      .select()
      .from(schema.bulkGenJobs)
      .where(eq(schema.bulkGenJobs.id, result.jobId))
      .get();
    expect(row?.status).toBe("in_progress");
    expect(row?.anthropicBatchId).toBe("batch_abc");
    handle.close();
  });

  it("persists the job as pending before the SDK call and marks failed on submit error", async () => {
    const stub = makeStubClient({
      create: vi.fn().mockRejectedValue(new Error("429 rate limit")),
    });
    await expect(
      createBulkJob({ n: 3, db: handle.db, client: stub.client }),
    ).rejects.toMatchObject({ code: "submit_failed" });
    const rows = handle.db
      .select()
      .from(schema.bulkGenJobs)
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("failed");
    expect(rows[0].lastError).toMatch(/429/);
    handle.close();
  });
});

describe("refreshBulkJob", () => {
  let handle: ReturnType<typeof freshDb>;
  beforeEach(() => {
    handle = freshDb();
    seedCurriculum(handle.db);
    callClaudeMock.mockReset();
  });

  it("throws not_found for unknown ids", async () => {
    await expect(
      refreshBulkJob("no-such-job", { db: handle.db }),
    ).rejects.toMatchObject({ code: "not_found" });
    handle.close();
  });

  it("updates status to ended when Anthropic reports ended", async () => {
    const creator = makeStubClient();
    const { jobId } = await createBulkJob({
      n: 1,
      db: handle.db,
      client: creator.client,
    });

    const endedAt = "2026-04-13T12:00:00Z";
    const refresher = makeStubClient({
      retrieve: vi.fn().mockResolvedValue({
        id: "batch_abc",
        processing_status: "ended",
        ended_at: endedAt,
        request_counts: {
          processing: 0,
          succeeded: 1,
          errored: 0,
          canceled: 0,
          expired: 0,
        },
      }),
    });

    const row = await refreshBulkJob(jobId, {
      db: handle.db,
      client: refresher.client,
    });
    expect(row.status).toBe("ended");
    expect(row.endedAt).toBeInstanceOf(Date);
    expect(refresher.batches.retrieve).toHaveBeenCalledWith("batch_abc");
    handle.close();
  });
});

describe("processBulkJob", () => {
  let handle: ReturnType<typeof freshDb>;
  beforeEach(() => {
    handle = freshDb();
    seedCurriculum(handle.db);
    callClaudeMock.mockReset();
  });

  it("throws not_ended when the job is still in progress", async () => {
    const creator = makeStubClient();
    const { jobId } = await createBulkJob({
      n: 1,
      db: handle.db,
      client: creator.client,
    });
    await expect(
      processBulkJob(jobId, { db: handle.db, client: creator.client }),
    ).rejects.toMatchObject({ code: "not_ended" });
    handle.close();
  });

  it("counts succeeded/rejected/failed and persists approved questions", async () => {
    const creator = makeStubClient();
    const { jobId, targets } = await createBulkJob({
      n: 3,
      db: handle.db,
      client: creator.client,
    });

    // Move job to ended
    handle.db
      .update(schema.bulkGenJobs)
      .set({ status: "ended", endedAt: new Date() })
      .where(eq(schema.bulkGenJobs.id, jobId))
      .run();

    // Build a results stream: one succeeded approved, one succeeded rejected,
    // one errored.
    const stream = async function* () {
      yield {
        custom_id: targets[0].customId,
        result: { type: "succeeded", message: batchMessage(goodQuestionInput()) },
      };
      yield {
        custom_id: targets[1].customId,
        result: { type: "succeeded", message: batchMessage(goodQuestionInput()) },
      };
      yield {
        custom_id: targets[2].customId,
        result: { type: "errored", error: { type: "error", error: { type: "invalid_request_error", message: "nope" } } },
      };
    };

    const processor = makeStubClient({
      results: vi.fn().mockResolvedValue(stream()),
    });

    // Reviewer: approve the first, reject the second.
    let reviewerCall = 0;
    callClaudeMock.mockImplementation(async (params: { role: string }) => {
      if (params.role !== "reviewer") throw new Error("unexpected role");
      reviewerCall++;
      if (reviewerCall === 1) {
        return reviewMessage({
          verdict: "approve",
          summary: "All criteria pass on review.",
        });
      }
      return reviewMessage({
        verdict: "reject",
        summary: "Distractor is out of scope.",
        violations: [
          {
            code: "implausible_distractor",
            detail: "Option D is absent from the knowledge bullets.",
          },
        ],
      });
    });

    const result = await processBulkJob(jobId, {
      db: handle.db,
      client: processor.client,
    });

    expect(result.succeeded).toBe(1);
    expect(result.rejected).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.alreadyProcessed).toBe(false);
    expect(result.actualCostCents).toBeGreaterThan(0);

    const persisted = handle.db
      .select()
      .from(schema.questions)
      .where(eq(schema.questions.source, "generated"))
      .all();
    expect(persisted).toHaveLength(1);
    expect(persisted[0].taskStatementId).toBe(targets[0].taskStatementId);

    const row = handle.db
      .select()
      .from(schema.bulkGenJobs)
      .where(eq(schema.bulkGenJobs.id, jobId))
      .get();
    expect(row?.processedAt).toBeInstanceOf(Date);
    expect(row?.succeededCount).toBe(1);
    expect(row?.rejectedCount).toBe(1);
    expect(row?.failedCount).toBe(1);
    handle.close();
  });

  it("is idempotent once processedAt is stamped", async () => {
    const creator = makeStubClient();
    const { jobId } = await createBulkJob({
      n: 1,
      db: handle.db,
      client: creator.client,
    });
    handle.db
      .update(schema.bulkGenJobs)
      .set({
        status: "ended",
        endedAt: new Date(),
        processedAt: new Date(),
        succeededCount: 4,
        rejectedCount: 1,
        failedCount: 0,
        costActualCents: 321,
      })
      .where(eq(schema.bulkGenJobs.id, jobId))
      .run();

    const processor = makeStubClient();
    const result = await processBulkJob(jobId, {
      db: handle.db,
      client: processor.client,
    });
    expect(result.alreadyProcessed).toBe(true);
    expect(result.succeeded).toBe(4);
    expect(result.rejected).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.actualCostCents).toBe(321);
    expect(processor.batches.results).not.toHaveBeenCalled();
    handle.close();
  });
});

describe("listBulkJobs", () => {
  it("returns recent jobs ordered by submission time", async () => {
    const handle = freshDb();
    seedCurriculum(handle.db);
    const creator = makeStubClient();
    const a = await createBulkJob({
      n: 1,
      db: handle.db,
      client: creator.client,
    });
    // Force a distinct submittedAt tick so sort order is deterministic —
    // unixepoch('subsec')*1000 can collide within the same ms otherwise.
    handle.db
      .update(schema.bulkGenJobs)
      .set({ submittedAt: new Date(Date.now() - 10_000) })
      .where(eq(schema.bulkGenJobs.id, a.jobId))
      .run();
    const b = await createBulkJob({
      n: 2,
      db: handle.db,
      client: creator.client,
    });
    const jobs = listBulkJobs(handle.db, 10);
    expect(jobs.map((j) => j.id)).toEqual([b.jobId, a.jobId]);
    handle.close();
  });
});

describe("BulkGenError", () => {
  it("is a distinct error type from generic Error", () => {
    const e = new BulkGenError("bad_n", "nope");
    expect(e).toBeInstanceOf(BulkGenError);
    expect(e.code).toBe("bad_n");
    expect(e.message).toBe("nope");
  });
});
