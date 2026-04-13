"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

interface FillResult {
  taskStatementId: string;
  bloomLevel: number;
  status: "ok" | "error";
  questionId?: string;
  attemptsUsed?: number;
  errorCode?: string;
  errorMessage?: string;
}

interface FillResponse {
  requested: number;
  attempted: number;
  succeeded: number;
  failed: number;
  results: FillResult[];
  note?: string;
}

const MAX_N = 10;

export default function CoverageFillForm({
  gapQuestions,
  apiKeyConfigured,
}: {
  gapQuestions: number;
  apiKeyConfigured: boolean;
}) {
  const router = useRouter();
  const [n, setN] = useState<number>(Math.min(3, Math.max(1, gapQuestions)));
  const [running, setRunning] = useState(false);
  const [response, setResponse] = useState<FillResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setRunning(true);
    setError(null);
    setResponse(null);
    try {
      const res = await fetch("/api/admin/coverage/fill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ n }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? `request failed (${res.status})`);
        return;
      }
      setResponse(data as FillResponse);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "request failed");
    } finally {
      setRunning(false);
    }
  }

  if (!apiKeyConfigured) {
    return (
      <section className="flex flex-col gap-2 rounded-xl border border-dashed border-amber-300 bg-amber-50 px-5 py-4 text-sm dark:border-amber-800 dark:bg-amber-950/30">
        <p className="font-medium text-amber-800 dark:text-amber-300">
          API key not configured
        </p>
        <p className="text-amber-700 dark:text-amber-400">
          Add your Anthropic API key in{" "}
          <a href="/settings" className="underline">
            settings
          </a>{" "}
          to enable generation.
        </p>
      </section>
    );
  }

  if (gapQuestions === 0) {
    return (
      <section className="rounded-xl border border-green-300 bg-green-50 px-5 py-4 text-sm text-green-800 dark:border-green-800 dark:bg-green-950/30 dark:text-green-300">
        Coverage is at target across every cell. Nothing to generate.
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-zinc-200 p-5 dark:border-zinc-800">
      <h2 className="text-lg font-semibold">Generate questions</h2>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        Generate N new questions, biggest-gap cells first. Each question goes
        through the reviewer gate before persisting (retry up to 3 times).
        Upper bound per run is {MAX_N} — larger bulk fills will use the Batches
        API (Phase 6c).
      </p>
      <div className="flex items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
          <span className="text-zinc-600 dark:text-zinc-400">N:</span>
          <input
            type="number"
            min={1}
            max={MAX_N}
            value={n}
            onChange={(e) =>
              setN(
                Math.max(
                  1,
                  Math.min(MAX_N, Number.parseInt(e.target.value, 10) || 1),
                ),
              )
            }
            className="w-20 rounded-md border border-zinc-300 bg-transparent px-2 py-1 text-right font-mono dark:border-zinc-700"
            disabled={running}
          />
        </label>
        <button
          type="button"
          onClick={() => void run()}
          disabled={running}
          className="rounded-full bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-800 disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
        >
          {running ? `Generating ${n}…` : `Generate ${n}`}
        </button>
        <span className="text-xs text-zinc-500">
          {gapQuestions} gap question{gapQuestions === 1 ? "" : "s"} total
        </span>
      </div>
      {error ? (
        <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
      ) : null}
      {response ? (
        <div className="flex flex-col gap-2 rounded-md bg-zinc-50 p-3 text-sm dark:bg-zinc-900">
          <p>
            <span className="font-semibold">{response.succeeded}</span>{" "}
            succeeded,{" "}
            <span
              className={
                response.failed > 0
                  ? "font-semibold text-red-600 dark:text-red-400"
                  : ""
              }
            >
              {response.failed} failed
            </span>{" "}
            (requested {response.requested}, attempted {response.attempted})
          </p>
          {response.note ? (
            <p className="text-zinc-600 dark:text-zinc-400">{response.note}</p>
          ) : null}
          <ul className="flex flex-col gap-1">
            {response.results.map((r, i) => (
              <li
                key={i}
                className="flex items-baseline justify-between gap-3 font-mono text-xs"
              >
                <span>
                  {r.taskStatementId} · L{r.bloomLevel}
                </span>
                <span
                  className={
                    r.status === "ok"
                      ? "text-green-700 dark:text-green-400"
                      : "text-red-600 dark:text-red-400"
                  }
                >
                  {r.status === "ok"
                    ? `ok (attempt ${r.attemptsUsed})`
                    : `${r.errorCode}: ${r.errorMessage}`}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
