"use client";

import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export interface ExplainerCheckQuestion {
  id: string;
  stem: string;
  options: string[];
  correctIndex: number;
  explanation: string;
  bloomLevel: number;
}

export interface ExplainerArtifact {
  narrativeMd: string;
  generatedAt: string | Date;
  checkQuestions: ExplainerCheckQuestion[];
  cached: boolean;
}

export default function StudyTaskDetail({
  taskStatementId,
  initialArtifact,
  apiKeyConfigured,
}: {
  taskStatementId: string;
  initialArtifact: ExplainerArtifact | null;
  apiKeyConfigured: boolean;
}) {
  const [artifact, setArtifact] = useState<ExplainerArtifact | null>(
    initialArtifact,
  );
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function generate() {
    setGenerating(true);
    setError(null);
    try {
      const res = await fetch("/api/study/explainer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskStatementId }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "generation failed");
        return;
      }
      setArtifact(data as ExplainerArtifact);
    } catch (err) {
      setError(err instanceof Error ? err.message : "request failed");
    } finally {
      setGenerating(false);
    }
  }

  if (!artifact) {
    return (
      <section className="flex flex-col gap-3 rounded-xl border border-dashed border-zinc-300 p-6 dark:border-zinc-700">
        <h2 className="text-lg font-semibold">Study narrative</h2>
        {!apiKeyConfigured ? (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            No API key configured.{" "}
            <a href="/settings" className="underline">
              Open settings
            </a>{" "}
            to add one, then come back to generate this narrative.
          </p>
        ) : (
          <>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              Claude will write a 600–1000 word narrative tying the Knowledge
              and Skills bullets together, plus 2–3 comprehension questions.
              This happens once per task statement; the result is cached.
            </p>
            <button
              type="button"
              onClick={generate}
              disabled={generating}
              className="self-start rounded-full bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-800 disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
            >
              {generating ? "Generating…" : "Generate narrative"}
            </button>
            {error ? (
              <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
            ) : null}
          </>
        )}
      </section>
    );
  }

  return (
    <>
      <section className="flex flex-col gap-4">
        <header className="flex items-baseline justify-between">
          <h2 className="text-lg font-semibold">Study narrative</h2>
          <p className="text-xs text-zinc-500">
            {artifact.cached ? "cached" : "fresh"} ·{" "}
            {new Date(artifact.generatedAt).toLocaleString()}
          </p>
        </header>
        <article className="prose prose-zinc max-w-none dark:prose-invert">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {artifact.narrativeMd}
          </ReactMarkdown>
        </article>
      </section>

      {artifact.checkQuestions.length > 0 ? (
        <section className="flex flex-col gap-6 rounded-xl border border-zinc-200 p-6 dark:border-zinc-800">
          <header className="flex flex-col gap-1">
            <h2 className="text-lg font-semibold">Check your understanding</h2>
            <p className="text-xs text-zinc-500">
              Answers are written as progress events — they feed mastery.
            </p>
          </header>
          {artifact.checkQuestions.map((q) => (
            <CheckQuestion
              key={q.id}
              question={q}
              taskStatementId={taskStatementId}
            />
          ))}
        </section>
      ) : null}
    </>
  );
}

function CheckQuestion({
  question,
  taskStatementId,
}: {
  question: ExplainerCheckQuestion;
  taskStatementId: string;
}) {
  const [selected, setSelected] = useState<number | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (selected === null) return;
    setError(null);
    try {
      const res = await fetch("/api/progress", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "explainer_check",
          taskStatementId,
          bloomLevel: question.bloomLevel,
          success: selected === question.correctIndex,
          payload: {
            question_id: question.id,
            selected,
            correct_index: question.correctIndex,
          },
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "could not save answer");
      }
      setSubmitted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "request failed");
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm font-medium">{question.stem}</p>
      <div className="flex flex-col gap-2">
        {question.options.map((opt, i) => {
          const isCorrect = submitted && i === question.correctIndex;
          const isWrong =
            submitted && i === selected && selected !== question.correctIndex;
          return (
            <label
              key={i}
              className={`flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2 text-sm ${
                isCorrect
                  ? "border-green-500 bg-green-50 dark:bg-green-950/30"
                  : isWrong
                    ? "border-red-500 bg-red-50 dark:bg-red-950/30"
                    : "border-zinc-200 dark:border-zinc-800"
              }`}
            >
              <input
                type="radio"
                name={question.id}
                value={i}
                disabled={submitted}
                checked={selected === i}
                onChange={() => setSelected(i)}
                className="mt-1"
              />
              <span>
                <span className="font-mono text-xs text-zinc-500">
                  {String.fromCharCode(65 + i)}.
                </span>{" "}
                {opt}
              </span>
            </label>
          );
        })}
      </div>
      {!submitted ? (
        <button
          type="button"
          onClick={submit}
          disabled={selected === null}
          className="self-start rounded-full bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-800 disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
        >
          Submit answer
        </button>
      ) : (
        <div className="rounded-md bg-zinc-50 p-3 text-sm text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
          <p className="mb-1 font-semibold">
            {selected === question.correctIndex ? "Correct." : "Not quite."}
          </p>
          <p>{question.explanation}</p>
        </div>
      )}
      {error ? (
        <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
      ) : null}
    </div>
  );
}
