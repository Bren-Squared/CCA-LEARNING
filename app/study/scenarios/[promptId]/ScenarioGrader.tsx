"use client";

import { useCallback, useState } from "react";

interface CriterionScore {
  id: string;
  score: number;
  reasoning: string;
}

interface GradeResult {
  attemptId: string;
  overallScore: number;
  success: boolean;
  perCriterion: CriterionScore[];
  strengths: string[];
  gaps: string[];
  modelAnswer: string;
  rubric: {
    criteria: Array<{ id: string; title: string; weight: number }>;
  };
  masteryScore: number;
  masteryItemCount: number;
}

export default function ScenarioGrader({
  promptId,
  rubricReady,
}: {
  promptId: string;
  rubricReady: boolean;
}) {
  const [answer, setAnswer] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<GradeResult | null>(null);

  const submit = useCallback(async () => {
    if (!answer.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/scenario/grade", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ promptId, answerText: answer }),
      });
      const body = (await res.json()) as Partial<GradeResult> & {
        error?: string;
        code?: string;
      };
      if (!res.ok) {
        throw new Error(
          body.error ?? `grade failed (${res.status})`,
        );
      }
      setResult(body as GradeResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : "unknown error");
    } finally {
      setSubmitting(false);
    }
  }, [answer, promptId, submitting]);

  function criterionTitle(id: string): string {
    const c = result?.rubric.criteria.find((x) => x.id === id);
    return c?.title ?? id;
  }

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <label
          htmlFor="answer"
          className="text-xs font-mono uppercase tracking-wider text-zinc-500"
        >
          Your answer
        </label>
        <textarea
          id="answer"
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          rows={10}
          placeholder="Write your free-response answer here. Cite specific scenario elements, name the concepts from the target task statement, and defend your design choices."
          className="w-full resize-y rounded-lg border border-zinc-300 bg-white px-3 py-2 font-mono text-sm leading-relaxed text-zinc-900 placeholder:text-zinc-400 focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
          disabled={submitting}
        />
        <div className="flex items-center justify-between text-xs text-zinc-500">
          <span className="font-mono">{answer.trim().length} chars</span>
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
          disabled={submitting || answer.trim().length < 20}
          className="rounded-full bg-zinc-900 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
        >
          {submitting ? "Grading…" : "Submit for grading"}
        </button>
        {answer.trim().length > 0 && answer.trim().length < 20 ? (
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
        <article className="flex flex-col gap-5 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
          <header className="flex items-baseline justify-between">
            <h2 className="text-sm font-semibold">Grade</h2>
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

          <div className="flex flex-col gap-3">
            <h3 className="text-xs font-mono uppercase tracking-wider text-zinc-500">
              Per criterion
            </h3>
            <ul className="flex flex-col gap-2">
              {result.perCriterion.map((c) => (
                <li
                  key={c.id}
                  className="flex flex-col gap-1 rounded-md bg-zinc-50 p-3 text-sm dark:bg-zinc-900/40"
                >
                  <div className="flex items-baseline justify-between">
                    <span className="font-medium">{criterionTitle(c.id)}</span>
                    <span className="font-mono text-sm">
                      {c.score} / 5
                    </span>
                  </div>
                  <p className="text-xs text-zinc-600 dark:text-zinc-400">
                    {c.reasoning}
                  </p>
                </li>
              ))}
            </ul>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <h3 className="text-xs font-mono uppercase tracking-wider text-emerald-700 dark:text-emerald-400">
                Strengths
              </h3>
              <ul className="flex list-disc flex-col gap-1 pl-4 text-sm">
                {result.strengths.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </div>
            <div className="flex flex-col gap-2">
              <h3 className="text-xs font-mono uppercase tracking-wider text-amber-700 dark:text-amber-400">
                Gaps
              </h3>
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

          <p className="text-xs text-zinc-500">
            Mastery snapshot for this Bloom level updated to{" "}
            <span className="font-mono">
              {result.masteryScore.toFixed(0)} / 100
            </span>{" "}
            across{" "}
            <span className="font-mono">{result.masteryItemCount}</span>{" "}
            event{result.masteryItemCount === 1 ? "" : "s"}.
          </p>
        </article>
      ) : null}
    </section>
  );
}
