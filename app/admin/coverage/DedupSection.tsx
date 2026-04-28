"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

interface DedupGroup {
  questionIds: string[];
  keepId: string;
  retireIds: string[];
  reason: string;
}

interface DedupCellResult {
  taskStatementId: string;
  bloomLevel: number;
  groups: DedupGroup[];
  totalQuestions: number;
  duplicatesFound: number;
}

interface DedupScanResult {
  cellsAnalyzed: number;
  cellsWithDuplicates: number;
  totalDuplicates: number;
  cells: DedupCellResult[];
}

export default function DedupSection({
  apiKeyConfigured,
}: {
  apiKeyConfigured: boolean;
}) {
  const router = useRouter();
  const [scanning, setScanning] = useState(false);
  const [result, setResult] = useState<DedupScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retiring, setRetiring] = useState(false);
  const [retireResult, setRetireResult] = useState<{
    retired: number;
  } | null>(null);

  async function scan() {
    setScanning(true);
    setError(null);
    setResult(null);
    setRetireResult(null);
    try {
      const res = await fetch("/api/admin/coverage/dedup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "analyze" }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? `request failed (${res.status})`);
        return;
      }
      setResult(data as DedupScanResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : "request failed");
    } finally {
      setScanning(false);
    }
  }

  async function retire() {
    if (!result) return;
    const retireIds = result.cells.flatMap((c) =>
      c.groups.flatMap((g) => g.retireIds),
    );
    if (retireIds.length === 0) return;

    setRetiring(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/coverage/dedup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "retire", retireIds }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? `retire failed (${res.status})`);
        return;
      }
      setRetireResult(data);
      setResult(null);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "retire failed");
    } finally {
      setRetiring(false);
    }
  }

  if (!apiKeyConfigured) return null;

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-zinc-200 p-5 dark:border-zinc-800">
      <h2 className="text-lg font-semibold">Deduplicate questions</h2>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        Scan every (task statement, Bloom level) cell for semantically similar
        questions. Claude (cheap model) analyzes each cell and recommends which
        duplicates to retire. Review the results before confirming.
      </p>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => void scan()}
          disabled={scanning || retiring}
          className="rounded-full bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-800 disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
        >
          {scanning ? "Scanning..." : "Scan for duplicates"}
        </button>
        {scanning ? (
          <span className="text-xs text-zinc-500">
            This may take a few minutes
          </span>
        ) : null}
      </div>

      {error ? (
        <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
      ) : null}

      {retireResult ? (
        <div className="rounded-md bg-green-50 p-3 text-sm text-green-800 dark:bg-green-950/30 dark:text-green-300">
          Retired {retireResult.retired} duplicate
          {retireResult.retired === 1 ? "" : "s"}. Coverage matrix updated.
        </div>
      ) : null}

      {result ? (
        <div className="flex flex-col gap-4 rounded-md bg-zinc-50 p-4 dark:bg-zinc-900">
          <div className="flex items-baseline justify-between text-sm">
            <span>
              Analyzed <strong>{result.cellsAnalyzed}</strong> cells —{" "}
              <strong>{result.cellsWithDuplicates}</strong> with duplicates —{" "}
              <strong className="text-amber-700 dark:text-amber-400">
                {result.totalDuplicates}
              </strong>{" "}
              question{result.totalDuplicates === 1 ? "" : "s"} to retire
            </span>
          </div>

          {result.totalDuplicates === 0 ? (
            <p className="text-sm text-green-700 dark:text-green-400">
              No duplicates found — the question bank is clean.
            </p>
          ) : (
            <>
              <div className="flex flex-col gap-3">
                {result.cells.map((cell) => (
                  <div
                    key={`${cell.taskStatementId}-${cell.bloomLevel}`}
                    className="flex flex-col gap-2 rounded-md border border-zinc-200 p-3 dark:border-zinc-800"
                  >
                    <div className="flex items-baseline justify-between text-sm">
                      <span className="font-mono text-xs text-zinc-500">
                        {cell.taskStatementId} · L{cell.bloomLevel}
                      </span>
                      <span className="text-xs text-amber-700 dark:text-amber-400">
                        {cell.duplicatesFound} to retire / {cell.totalQuestions}{" "}
                        total
                      </span>
                    </div>
                    {cell.groups.map((group, gi) => (
                      <div
                        key={gi}
                        className="flex flex-col gap-1 border-l-2 border-zinc-300 pl-3 text-xs dark:border-zinc-700"
                      >
                        <p className="text-zinc-600 dark:text-zinc-400">
                          {group.reason}
                        </p>
                        {group.questionIds.map((qid) => (
                          <p
                            key={qid}
                            className={`font-mono ${
                              qid === group.keepId
                                ? "text-green-700 dark:text-green-400"
                                : "text-zinc-400 line-through dark:text-zinc-600"
                            }`}
                          >
                            {qid === group.keepId ? "keep" : "retire"} {qid}
                          </p>
                        ))}
                      </div>
                    ))}
                  </div>
                ))}
              </div>

              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => void retire()}
                  disabled={retiring}
                  className="rounded-full bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-60"
                >
                  {retiring
                    ? "Retiring..."
                    : `Retire ${result.totalDuplicates} duplicate${result.totalDuplicates === 1 ? "" : "s"}`}
                </button>
                <button
                  type="button"
                  onClick={() => setResult(null)}
                  disabled={retiring}
                  className="rounded-full border border-zinc-300 px-4 py-2 text-sm transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
                >
                  Cancel
                </button>
              </div>
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}
