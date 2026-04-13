"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { BulkGenJob } from "@/lib/db/schema";

interface BulkCostProjection {
  targetCount: number;
  projectedCostUsd: number;
  projectedCostCents: number;
  ceilingUsd: number;
  exceedsCeiling: boolean;
  generatorModel: string;
  reviewerModel: string;
}

const MAX_BULK_N = 200;

function formatUsd(cents: number | null | undefined): string {
  if (cents == null) return "—";
  return `$${(cents / 100).toFixed(2)}`;
}

function statusPillClass(status: BulkGenJob["status"]): string {
  switch (status) {
    case "ended":
      return "bg-green-100 text-green-800 dark:bg-green-950/40 dark:text-green-300";
    case "in_progress":
    case "pending":
      return "bg-blue-100 text-blue-800 dark:bg-blue-950/40 dark:text-blue-300";
    case "canceled":
    case "expired":
      return "bg-zinc-200 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-300";
    case "failed":
      return "bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-300";
  }
}

function formatTimestamp(ts: Date | string | number | null): string {
  if (ts == null) return "—";
  const d = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}

export default function BulkSection({
  gapQuestions,
  apiKeyConfigured,
  jobs,
  ceilingUsd,
}: {
  gapQuestions: number;
  apiKeyConfigured: boolean;
  jobs: BulkGenJob[];
  ceilingUsd: number;
}) {
  const router = useRouter();
  const [n, setN] = useState<number>(
    Math.min(MAX_BULK_N, Math.max(10, gapQuestions)),
  );
  const [confirm, setConfirm] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [lastProjection, setLastProjection] =
    useState<BulkCostProjection | null>(null);
  const [pollingId, setPollingId] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);

  async function createJob() {
    setCreating(true);
    setCreateError(null);
    setLastProjection(null);
    try {
      const res = await fetch("/api/admin/coverage/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ n, confirm }),
      });
      const data = await res.json();
      if (res.status === 402 && data.detail?.projection) {
        setCreateError(
          `${data.error} — tick "confirm over ceiling" and retry.`,
        );
        setLastProjection(data.detail.projection as BulkCostProjection);
        return;
      }
      if (!res.ok) {
        setCreateError(data.error ?? `request failed (${res.status})`);
        return;
      }
      setLastProjection(data.projection as BulkCostProjection);
      router.refresh();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "request failed");
    } finally {
      setCreating(false);
    }
  }

  async function pollJob(id: string) {
    setPollingId(id);
    setPollError(null);
    try {
      const res = await fetch(
        `/api/admin/coverage/bulk/${encodeURIComponent(id)}/poll`,
        { method: "POST" },
      );
      const data = await res.json();
      if (!res.ok) {
        setPollError(data.error ?? `poll failed (${res.status})`);
        return;
      }
      router.refresh();
    } catch (err) {
      setPollError(err instanceof Error ? err.message : "poll failed");
    } finally {
      setPollingId(null);
    }
  }

  if (!apiKeyConfigured) {
    return null;
  }

  return (
    <section className="flex flex-col gap-4 rounded-xl border border-zinc-200 p-5 dark:border-zinc-800">
      <header className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold">Bulk generate (Batches API)</h2>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Submit up to {MAX_BULK_N} generator requests to Anthropic&rsquo;s
          Batches API (50% discount). Reviewer runs sync per returned result
          when you poll. No retries — rejections are terminal. Cost ceiling:{" "}
          <span className="font-mono">${ceilingUsd.toFixed(2)}</span>.
        </p>
      </header>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
          <span className="text-zinc-600 dark:text-zinc-400">N:</span>
          <input
            type="number"
            min={1}
            max={MAX_BULK_N}
            value={n}
            onChange={(e) =>
              setN(
                Math.max(
                  1,
                  Math.min(
                    MAX_BULK_N,
                    Number.parseInt(e.target.value, 10) || 1,
                  ),
                ),
              )
            }
            className="w-24 rounded-md border border-zinc-300 bg-transparent px-2 py-1 text-right font-mono dark:border-zinc-700"
            disabled={creating}
          />
        </label>
        <label className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
          <input
            type="checkbox"
            checked={confirm}
            onChange={(e) => setConfirm(e.target.checked)}
            disabled={creating}
          />
          <span>Confirm over ceiling</span>
        </label>
        <button
          type="button"
          onClick={() => void createJob()}
          disabled={creating || gapQuestions === 0}
          className="rounded-full bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-800 disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
        >
          {creating ? `Submitting ${n}…` : `Submit batch of ${n}`}
        </button>
        <span className="text-xs text-zinc-500">
          {gapQuestions} gap question{gapQuestions === 1 ? "" : "s"} total
        </span>
      </div>
      {lastProjection ? (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Projection: {lastProjection.targetCount} targets ·{" "}
          <span className="font-mono">
            ${lastProjection.projectedCostUsd.toFixed(2)}
          </span>{" "}
          (gen {lastProjection.generatorModel}, review{" "}
          {lastProjection.reviewerModel})
        </p>
      ) : null}
      {createError ? (
        <p className="text-sm text-red-600 dark:text-red-400">{createError}</p>
      ) : null}

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">
          Recent jobs
        </h3>
        {jobs.length === 0 ? (
          <p className="text-sm text-zinc-500">No bulk jobs yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {jobs.map((job) => (
              <li
                key={job.id}
                className="flex flex-col gap-2 rounded-md border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-800"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-3">
                  <span className="font-mono text-xs text-zinc-500">
                    {job.id.slice(0, 8)}… · {job.requestedN} req ·{" "}
                    {formatTimestamp(job.submittedAt)}
                  </span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusPillClass(job.status)}`}
                  >
                    {job.status}
                  </span>
                </div>
                <div className="flex flex-wrap items-baseline gap-4 text-xs text-zinc-600 dark:text-zinc-400">
                  <span>
                    Projected{" "}
                    <span className="font-mono">
                      {formatUsd(job.costProjectedCents)}
                    </span>
                  </span>
                  <span>
                    Actual{" "}
                    <span className="font-mono">
                      {formatUsd(job.costActualCents)}
                    </span>
                  </span>
                  <span>
                    Succeeded{" "}
                    <span className="font-mono">{job.succeededCount}</span>
                  </span>
                  <span>
                    Rejected{" "}
                    <span className="font-mono">{job.rejectedCount}</span>
                  </span>
                  <span>
                    Failed <span className="font-mono">{job.failedCount}</span>
                  </span>
                  {job.anthropicBatchId ? (
                    <span className="font-mono text-zinc-500">
                      {job.anthropicBatchId.slice(0, 10)}…
                    </span>
                  ) : null}
                </div>
                {job.lastError ? (
                  <p className="text-xs text-red-600 dark:text-red-400">
                    {job.lastError}
                  </p>
                ) : null}
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => void pollJob(job.id)}
                    disabled={
                      pollingId === job.id ||
                      job.status === "failed" ||
                      job.status === "canceled" ||
                      job.status === "expired" ||
                      Boolean(job.processedAt)
                    }
                    className="rounded-full border border-zinc-300 px-3 py-1 text-xs transition-colors hover:bg-zinc-100 disabled:opacity-60 dark:border-zinc-700 dark:hover:bg-zinc-900"
                  >
                    {pollingId === job.id
                      ? "Polling…"
                      : job.processedAt
                        ? "Processed"
                        : "Poll"}
                  </button>
                  {job.processedAt ? (
                    <span className="text-xs text-zinc-500">
                      Processed {formatTimestamp(job.processedAt)}
                    </span>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
        {pollError ? (
          <p className="text-sm text-red-600 dark:text-red-400">{pollError}</p>
        ) : null}
      </div>
    </section>
  );
}
