import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import Anthropic from "@anthropic-ai/sdk";
import { NoApiKeyError } from "../claude/client";
import {
  BATCH_DISCOUNT,
  PER_QUESTION_USAGE,
  estimateCallCostUsd,
} from "../claude/pricing";
import { estimateCostUsd, recordCall } from "../claude/tokens";
import { type Db, getAppDb, schema } from "../db";
import type { BloomLevel } from "../progress/mastery";
import { getApiKey, readSettings } from "../settings";
import { buildCoverageReport, selectFillTargets } from "./coverage";
import {
  GENERATOR_TOOL_PARAMS,
  buildGeneratorSystemPrompt,
  callReviewer,
  loadGeneratorContext,
  parseGeneratorMessage,
  persistApprovedQuestion,
  validateBulletIdxs,
} from "./generator";

/**
 * Upper cap per bulk invocation. The Batches API supports much larger
 * payloads, but for a single-user study bank 200 is plenty — and the
 * projected cost at 200 is already mid-single-digit dollars on Opus 4.6.
 */
export const MAX_BULK_N = 200;

export interface BulkTarget {
  taskStatementId: string;
  bloomLevel: BloomLevel;
}

interface StoredTarget {
  customId: string;
  taskStatementId: string;
  bloomLevel: number;
}

export interface BulkCostProjection {
  targetCount: number;
  projectedCostUsd: number;
  projectedCostCents: number;
  ceilingUsd: number;
  exceedsCeiling: boolean;
  generatorModel: string;
  reviewerModel: string;
}

/**
 * Project the cost of generating `targets.length` questions through the
 * bulk pipeline. Generator runs on the default (opus) tier under the batch
 * discount; reviewer runs sync on the cheap tier and is not discounted.
 * Per-question token usage is calibrated against Phase 6a live smokes and
 * rounded up so the projection is conservative.
 */
export function projectBulkCost(
  targets: BulkTarget[],
  db: Db = getAppDb(),
): BulkCostProjection {
  const settings = readSettings(db);
  const generatorModel = settings.defaultModel;
  const reviewerModel = settings.cheapModel;

  const perQuestionUsd =
    estimateCallCostUsd(
      generatorModel,
      {
        inputTokens: PER_QUESTION_USAGE.generator.inputTokens,
        outputTokens: PER_QUESTION_USAGE.generator.outputTokens,
      },
      { batch: true },
    ) +
    estimateCallCostUsd(reviewerModel, {
      inputTokens: PER_QUESTION_USAGE.reviewer.inputTokens,
      outputTokens: PER_QUESTION_USAGE.reviewer.outputTokens,
    });

  const projectedCostUsd = perQuestionUsd * targets.length;
  const projectedCostCents = Math.ceil(projectedCostUsd * 100);

  return {
    targetCount: targets.length,
    projectedCostUsd,
    projectedCostCents,
    ceilingUsd: settings.bulkCostCeilingUsd,
    exceedsCeiling: projectedCostUsd > settings.bulkCostCeilingUsd,
    generatorModel,
    reviewerModel,
  };
}

export class BulkGenError extends Error {
  readonly code:
    | "no_api_key"
    | "bad_n"
    | "no_gaps"
    | "over_ceiling"
    | "submit_failed"
    | "not_found"
    | "not_ended";
  readonly detail?: unknown;
  constructor(code: BulkGenError["code"], message: string, detail?: unknown) {
    super(message);
    this.code = code;
    this.detail = detail;
    this.name = "BulkGenError";
  }
}

export interface CreateBulkJobParams {
  n: number;
  confirm?: boolean;
  db?: Db;
  /** Escape hatch for tests — injects a stub Anthropic client. */
  client?: Anthropic;
}

export interface CreateBulkJobResult {
  jobId: string;
  anthropicBatchId: string;
  projection: BulkCostProjection;
  targets: StoredTarget[];
}

function makeAnthropicClient(db: Db): Anthropic {
  const key = getApiKey(db);
  if (!key) throw new NoApiKeyError();
  return new Anthropic({ apiKey: key });
}

function buildBatchRequest(
  target: StoredTarget,
  db: Db,
  generatorModel: string,
): Anthropic.Messages.BatchCreateParams.Request {
  const bloom = target.bloomLevel as BloomLevel;
  const ctx = loadGeneratorContext(
    { taskStatementId: target.taskStatementId, bloomLevel: bloom },
    db,
  );
  const systemText = buildGeneratorSystemPrompt(ctx, bloom, []);
  return {
    custom_id: target.customId,
    params: {
      model: generatorModel,
      max_tokens: GENERATOR_TOOL_PARAMS.maxTokens,
      temperature: GENERATOR_TOOL_PARAMS.temperature,
      system: systemText,
      messages: [
        {
          role: "user",
          content: `Author ONE new MCQ for task statement ${ctx.ts.id} at Bloom level ${bloom}.`,
        },
      ],
      tools: GENERATOR_TOOL_PARAMS.tools,
      tool_choice: GENERATOR_TOOL_PARAMS.toolChoice,
    },
  };
}

/**
 * Select the next N coverage targets, project cost, submit a Batches API
 * job, and persist a bulk_gen_jobs row. Rejects with code="over_ceiling"
 * when the projection exceeds `settings.bulk_cost_ceiling_usd` unless the
 * caller passes `confirm: true`.
 */
export async function createBulkJob(
  params: CreateBulkJobParams,
): Promise<CreateBulkJobResult> {
  const db = params.db ?? getAppDb();

  if (!Number.isInteger(params.n) || params.n < 1 || params.n > MAX_BULK_N) {
    throw new BulkGenError(
      "bad_n",
      `n must be an integer between 1 and ${MAX_BULK_N}`,
    );
  }

  const report = buildCoverageReport(db);
  const rawTargets = selectFillTargets(report, params.n);
  if (rawTargets.length === 0) {
    throw new BulkGenError("no_gaps", "no coverage gaps available to fill");
  }

  const targets: StoredTarget[] = rawTargets.map((t, i) => ({
    // Anthropic's custom_id pattern is ^[a-zA-Z0-9_-]{1,64}$ — replace any
    // other characters (task IDs contain '.') with hyphens.
    customId: `q-${String(i).padStart(3, "0")}-${t.taskStatementId.replace(/[^a-zA-Z0-9_-]/g, "-")}-L${t.bloomLevel}`,
    taskStatementId: t.taskStatementId,
    bloomLevel: t.bloomLevel,
  }));

  const projection = projectBulkCost(
    targets.map((t) => ({
      taskStatementId: t.taskStatementId,
      bloomLevel: t.bloomLevel as BloomLevel,
    })),
    db,
  );

  if (projection.exceedsCeiling && !params.confirm) {
    throw new BulkGenError(
      "over_ceiling",
      `projected $${projection.projectedCostUsd.toFixed(2)} exceeds ceiling $${projection.ceilingUsd.toFixed(2)}; pass confirm: true to proceed`,
      { projection },
    );
  }

  const requests = targets.map((t) =>
    buildBatchRequest(t, db, projection.generatorModel),
  );

  const jobId = randomUUID();
  db.insert(schema.bulkGenJobs)
    .values({
      id: jobId,
      status: "pending",
      requestedN: targets.length,
      targets,
      costProjectedCents: projection.projectedCostCents,
    })
    .run();

  let batchId: string;
  try {
    const client = params.client ?? makeAnthropicClient(db);
    const batch = await client.messages.batches.create({ requests });
    batchId = batch.id;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    db.update(schema.bulkGenJobs)
      .set({ status: "failed", lastError: message, endedAt: new Date() })
      .where(eq(schema.bulkGenJobs.id, jobId))
      .run();
    throw new BulkGenError("submit_failed", message, err);
  }

  db.update(schema.bulkGenJobs)
    .set({ anthropicBatchId: batchId, status: "in_progress" })
    .where(eq(schema.bulkGenJobs.id, jobId))
    .run();

  return { jobId, anthropicBatchId: batchId, projection, targets };
}

function mapProcessingStatus(
  status: "in_progress" | "canceling" | "ended",
): schema.BulkGenJob["status"] {
  if (status === "ended") return "ended";
  return "in_progress";
}

export interface RefreshParams {
  db?: Db;
  client?: Anthropic;
}

/**
 * Poll the Anthropic batch endpoint for the job's current processing
 * status and persist the result. Returns the updated row. No-op (just a
 * read) when the job has no batch id yet.
 */
export async function refreshBulkJob(
  jobId: string,
  params: RefreshParams = {},
): Promise<schema.BulkGenJob> {
  const db = params.db ?? getAppDb();
  const job = db
    .select()
    .from(schema.bulkGenJobs)
    .where(eq(schema.bulkGenJobs.id, jobId))
    .get();
  if (!job) throw new BulkGenError("not_found", `job "${jobId}" not found`);
  if (!job.anthropicBatchId) return job;

  const client = params.client ?? makeAnthropicClient(db);
  const batch = await client.messages.batches.retrieve(job.anthropicBatchId);

  db.update(schema.bulkGenJobs)
    .set({
      status: mapProcessingStatus(batch.processing_status),
      endedAt: batch.ended_at ? new Date(batch.ended_at) : null,
    })
    .where(eq(schema.bulkGenJobs.id, jobId))
    .run();

  return (
    db
      .select()
      .from(schema.bulkGenJobs)
      .where(eq(schema.bulkGenJobs.id, jobId))
      .get() ?? job
  );
}

export interface ProcessResult {
  jobId: string;
  succeeded: number;
  rejected: number;
  failed: number;
  actualCostCents: number;
  alreadyProcessed: boolean;
}

/**
 * Stream batch results from Anthropic, run the reviewer synchronously for
 * each successful generator output, and persist approved questions. Must
 * be called only after the job status transitions to `ended`. Idempotent:
 * re-calling a processed job returns the stored counts without re-running.
 */
export async function processBulkJob(
  jobId: string,
  params: RefreshParams = {},
): Promise<ProcessResult> {
  const db = params.db ?? getAppDb();
  const job = db
    .select()
    .from(schema.bulkGenJobs)
    .where(eq(schema.bulkGenJobs.id, jobId))
    .get();
  if (!job) throw new BulkGenError("not_found", `job "${jobId}" not found`);

  if (job.processedAt) {
    return {
      jobId,
      succeeded: job.succeededCount,
      rejected: job.rejectedCount,
      failed: job.failedCount,
      actualCostCents: job.costActualCents ?? 0,
      alreadyProcessed: true,
    };
  }

  if (job.status !== "ended") {
    throw new BulkGenError(
      "not_ended",
      `job "${jobId}" status is ${job.status}; refresh until ended before processing`,
    );
  }
  if (!job.anthropicBatchId) {
    throw new BulkGenError(
      "not_ended",
      `job "${jobId}" has no anthropic_batch_id`,
    );
  }

  const targetsById = new Map(job.targets.map((t) => [t.customId, t]));
  const client = params.client ?? makeAnthropicClient(db);
  const results = await client.messages.batches.results(job.anthropicBatchId);

  let succeeded = 0;
  let rejected = 0;
  let failed = 0;
  let generatorCostUsd = 0;

  for await (const entry of results) {
    const target = targetsById.get(entry.custom_id);
    if (!target) {
      failed += 1;
      continue;
    }

    if (entry.result.type !== "succeeded") {
      failed += 1;
      continue;
    }

    const message = entry.result.message;
    recordCall(
      {
        role: "generator_batch",
        model: message.model,
        usage: message.usage,
        stopReason: message.stop_reason,
        durationMs: 0,
        batch: true,
      },
      db,
    );
    generatorCostUsd += estimateCostUsd(message.model, message.usage, {
      batch: true,
    });

    let candidate;
    try {
      candidate = parseGeneratorMessage(message);
    } catch {
      failed += 1;
      continue;
    }

    try {
      const ctx = loadGeneratorContext(
        { taskStatementId: target.taskStatementId, bloomLevel: target.bloomLevel as BloomLevel },
        db,
      );
      // Phase 16 / E3 — bullet-citation guard runs before the (cheap) reviewer
      // call so a structurally invalid candidate is rejected without burning
      // an extra Claude invocation.
      const bulletViolation = validateBulletIdxs(candidate, ctx.ts);
      if (bulletViolation) {
        rejected += 1;
        continue;
      }
      const review = await callReviewer(
        ctx.ts,
        target.bloomLevel as BloomLevel,
        candidate,
        db,
      );
      if (review.verdict === "approve") {
        persistApprovedQuestion(ctx.ts, null, candidate, db);
        succeeded += 1;
      } else {
        rejected += 1;
      }
    } catch {
      failed += 1;
    }
  }

  // Reviewer cost is logged individually via callClaude/recordCall; we
  // estimate it here only to populate costActualCents. The per-call log
  // is the canonical source for spend analysis.
  const settings = readSettings(db);
  const reviewerCallCount = succeeded + rejected;
  const reviewerCostUsd =
    reviewerCallCount *
    estimateCallCostUsd(settings.cheapModel, {
      inputTokens: PER_QUESTION_USAGE.reviewer.inputTokens,
      outputTokens: PER_QUESTION_USAGE.reviewer.outputTokens,
    });
  const actualCostCents = Math.ceil(
    (generatorCostUsd + reviewerCostUsd) * 100,
  );

  db.update(schema.bulkGenJobs)
    .set({
      succeededCount: succeeded,
      rejectedCount: rejected,
      failedCount: failed,
      costActualCents: actualCostCents,
      processedAt: new Date(),
    })
    .where(eq(schema.bulkGenJobs.id, jobId))
    .run();

  return {
    jobId,
    succeeded,
    rejected,
    failed,
    actualCostCents,
    alreadyProcessed: false,
  };
}

export function listBulkJobs(
  db: Db = getAppDb(),
  limit = 20,
): schema.BulkGenJob[] {
  return db
    .select()
    .from(schema.bulkGenJobs)
    .orderBy(desc(schema.bulkGenJobs.submittedAt))
    .limit(limit)
    .all();
}

export function getBulkJob(
  jobId: string,
  db: Db = getAppDb(),
): schema.BulkGenJob | null {
  return (
    db
      .select()
      .from(schema.bulkGenJobs)
      .where(eq(schema.bulkGenJobs.id, jobId))
      .get() ?? null
  );
}

// Re-export BATCH_DISCOUNT for admin UI/tests that want to show the rate.
export { BATCH_DISCOUNT };
