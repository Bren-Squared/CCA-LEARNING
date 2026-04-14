"use client";

import { useCallback, useState } from "react";

interface CriterionScore {
  id: string;
  score: number;
  reasoning: string;
}

interface LatestAttempt {
  grade: number | null;
  strengths: string[];
  gaps: string[];
  modelAnswer: string;
  perCriterion: CriterionScore[];
  createdAt: string;
}

interface MasterySnapshot {
  taskStatementId: string;
  score: number;
  itemCount: number;
}

interface GradeResult {
  attemptId: string;
  stepId: string;
  exerciseId: string;
  overallScore: number;
  success: boolean;
  perCriterion: CriterionScore[];
  strengths: string[];
  gaps: string[];
  modelAnswer: string;
  rubric: {
    criteria: Array<{ id: string; title: string; weight: number }>;
  };
  reinforcedTaskStatementIds: string[];
  masterySnapshots: MasterySnapshot[];
}

export default function ExerciseStepGrader({
  stepId,
  stepIdx,
  stepTotal,
  rubricReady,
  latestAttempt,
}: {
  stepId: string;
  stepIdx: number;
  stepTotal: number;
  rubricReady: boolean;
  latestAttempt: LatestAttempt | null;
}) {
  const [artifact, setArtifact] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<GradeResult | null>(null);

  const submit = useCallback(async () => {
    if (artifact.trim().length < 20 || submitting) return;
    setSubmitting(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch(
        `/api/exercises/${encodeURIComponent(stepId)}/grade`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ artifactText: artifact }),
        },
      );
      const body = (await res.json()) as Partial<GradeResult> & {
        error?: string;
        code?: string;
      };
      if (!res.ok) {
        throw new Error(body.error ?? `grade failed (${res.status})`);
      }
      setResult(body as GradeResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : "unknown error");
    } finally {
      setSubmitting(false);
    }
  }, [artifact, stepId, submitting]);

  function criterionTitle(id: string): string {
    const c = result?.rubric.criteria.find((x) => x.id === id);
    return c?.title ?? id;
  }

  const showLatest = result === null && latestAttempt !== null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <label
          htmlFor={`artifact-${stepId}`}
          className="text-xs font-mono uppercase tracking-wider text-zinc-500"
        >
          Your artifact for step {stepIdx + 1} of {stepTotal}
        </label>
        <textarea
          id={`artifact-${stepId}`}
          value={artifact}
          onChange={(e) => setArtifact(e.target.value)}
          rows={10}
          placeholder="Paste the artifact this step asks for — code, config, a design, or prose. Build on the prior step's artifact if any."
          className="w-full resize-y rounded-lg border border-zinc-300 bg-white px-3 py-2 font-mono text-sm leading-relaxed text-zinc-900 placeholder:text-zinc-400 focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
          disabled={submitting}
        />
        <div className="flex items-center justify-between text-xs text-zinc-500">
          <span className="font-mono">{artifact.trim().length} chars</span>
          <span>
            {rubricReady
              ? "Rubric ready — single Claude call."
              : "First attempt will author the rubric (two Claude calls)."}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => void submit()}
          disabled={submitting || artifact.trim().length < 20}
          className="rounded-full bg-zinc-900 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
        >
          {submitting ? "Grading…" : "Submit for grading"}
        </button>
        {artifact.trim().length > 0 && artifact.trim().length < 20 ? (
          <span className="text-xs text-zinc-500">
            Need at least 20 characters.
          </span>
        ) : null}
      </div>

      {error ? (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
          {error}
        </p>
      ) : null}

      {result ? (
        <article className="flex flex-col gap-4 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
          <header className="flex items-baseline justify-between">
            <h3 className="text-sm font-semibold">
              Grade{" "}
              <span
                className={
                  result.success
                    ? "font-mono text-xs text-emerald-700 dark:text-emerald-400"
                    : "font-mono text-xs text-amber-700 dark:text-amber-400"
                }
              >
                {result.success ? "· passed — Create events written" : "· below 3.0, no events"}
              </span>
            </h3>
            <span
              className={
                result.overallScore >= 4
                  ? "font-mono text-2xl font-semibold text-emerald-700 dark:text-emerald-400"
                  : result.overallScore >= 3
                    ? "font-mono text-2xl font-semibold text-amber-700 dark:text-amber-400"
                    : "font-mono text-2xl font-semibold text-red-700 dark:text-red-400"
              }
            >
              {result.overallScore.toFixed(1)} / 5
            </span>
          </header>

          <ul className="flex flex-col gap-2">
            {result.perCriterion.map((c) => (
              <li
                key={c.id}
                className="flex flex-col gap-1 rounded-md bg-zinc-50 p-3 text-sm dark:bg-zinc-900/40"
              >
                <div className="flex items-baseline justify-between">
                  <span className="font-medium">{criterionTitle(c.id)}</span>
                  <span className="font-mono text-sm">{c.score} / 5</span>
                </div>
                <p className="text-xs text-zinc-600 dark:text-zinc-400">
                  {c.reasoning}
                </p>
              </li>
            ))}
          </ul>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <h4 className="text-xs font-mono uppercase tracking-wider text-emerald-700 dark:text-emerald-400">
                Strengths
              </h4>
              <ul className="flex list-disc flex-col gap-1 pl-4 text-sm">
                {result.strengths.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </div>
            <div className="flex flex-col gap-2">
              <h4 className="text-xs font-mono uppercase tracking-wider text-amber-700 dark:text-amber-400">
                Gaps
              </h4>
              <ul className="flex list-disc flex-col gap-1 pl-4 text-sm">
                {result.gaps.map((g, i) => (
                  <li key={i}>{g}</li>
                ))}
              </ul>
            </div>
          </div>

          <details className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
            <summary className="cursor-pointer text-xs font-mono uppercase tracking-wider text-zinc-500">
              Model answer
            </summary>
            <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
              {result.modelAnswer}
            </p>
          </details>

          {result.success ? (
            <div className="flex flex-col gap-1 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-200">
              <p className="font-semibold">
                Bloom L6 (Create) events written to{" "}
                {result.reinforcedTaskStatementIds.length} task statement
                {result.reinforcedTaskStatementIds.length === 1 ? "" : "s"}.
              </p>
              <ul className="flex flex-col gap-0.5 font-mono">
                {result.masterySnapshots.map((m) => (
                  <li key={m.taskStatementId}>
                    {m.taskStatementId} — L6 mastery {m.score.toFixed(0)} / 100
                    ({m.itemCount} event{m.itemCount === 1 ? "" : "s"})
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-xs text-zinc-500">
              Score below 3.0 — no progress events written. Address the gaps
              and resubmit to earn Create-level mastery.
            </p>
          )}
        </article>
      ) : null}

      {showLatest && latestAttempt ? (
        <article className="flex flex-col gap-3 rounded-xl border border-zinc-200 bg-zinc-50 p-4 text-sm dark:border-zinc-800 dark:bg-zinc-950/40">
          <header className="flex items-baseline justify-between">
            <h3 className="text-xs font-mono uppercase tracking-wider text-zinc-500">
              Latest attempt ·{" "}
              {new Date(latestAttempt.createdAt)
                .toISOString()
                .slice(0, 16)
                .replace("T", " ")}
            </h3>
            {latestAttempt.grade !== null ? (
              <span
                className={
                  latestAttempt.grade >= 4
                    ? "font-mono text-sm font-semibold text-emerald-700 dark:text-emerald-400"
                    : latestAttempt.grade >= 3
                      ? "font-mono text-sm font-semibold text-amber-700 dark:text-amber-400"
                      : "font-mono text-sm font-semibold text-red-700 dark:text-red-400"
                }
              >
                {latestAttempt.grade.toFixed(1)} / 5
              </span>
            ) : null}
          </header>
          <div className="grid gap-3 sm:grid-cols-2 text-xs">
            <div>
              <p className="font-mono uppercase tracking-wider text-emerald-700 dark:text-emerald-400">
                Strengths
              </p>
              <ul className="mt-1 flex list-disc flex-col gap-1 pl-4">
                {latestAttempt.strengths.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </div>
            <div>
              <p className="font-mono uppercase tracking-wider text-amber-700 dark:text-amber-400">
                Gaps
              </p>
              <ul className="mt-1 flex list-disc flex-col gap-1 pl-4">
                {latestAttempt.gaps.map((g, i) => (
                  <li key={i}>{g}</li>
                ))}
              </ul>
            </div>
          </div>
        </article>
      ) : null}
    </div>
  );
}
