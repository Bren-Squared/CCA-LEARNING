"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { DrillQuestion } from "@/lib/study/drill";

interface AnswerRecord {
  questionId: string;
  taskStatementId: string;
  taskStatementTitle: string;
  bloomLevel: number;
  success: boolean;
}

type Phase = "answering" | "reviewing" | "done";

export default function DrillSession({
  questions,
  scopeLabel,
}: {
  questions: DrillQuestion[];
  scopeLabel: string;
}) {
  const [index, setIndex] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const [phase, setPhase] = useState<Phase>("answering");
  const [answers, setAnswers] = useState<AnswerRecord[]>([]);
  const [postError, setPostError] = useState<string | null>(null);

  const current = questions[index];
  const total = questions.length;
  const optionLetters = ["A", "B", "C", "D", "E", "F"];

  const submit = useCallback(async () => {
    if (phase !== "answering" || selected === null || !current) return;
    const success = selected === current.correctIndex;
    const record: AnswerRecord = {
      questionId: current.id,
      taskStatementId: current.taskStatementId,
      taskStatementTitle: current.taskStatementTitle,
      bloomLevel: current.bloomLevel,
      success,
    };
    setAnswers((prev) => [...prev, record]);
    setPhase("reviewing");
    setPostError(null);
    try {
      const res = await fetch("/api/progress", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "mcq_answer",
          taskStatementId: current.taskStatementId,
          bloomLevel: current.bloomLevel,
          success,
          payload: {
            question_id: current.id,
            selected,
            correct_index: current.correctIndex,
            scope: scopeLabel,
          },
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setPostError(data.error ?? "could not save answer");
      }
    } catch (err) {
      setPostError(err instanceof Error ? err.message : "request failed");
    }
  }, [current, phase, selected, scopeLabel]);

  const advance = useCallback(() => {
    if (phase !== "reviewing") return;
    if (index + 1 >= total) {
      setPhase("done");
      return;
    }
    setIndex((i) => i + 1);
    setSelected(null);
    setPhase("answering");
  }, [index, phase, total]);

  const endEarly = useCallback(() => {
    if (phase === "done") return;
    setPhase("done");
  }, [phase]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (phase === "done") return;
      if (e.key === "Escape") {
        e.preventDefault();
        endEarly();
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        if (phase === "answering") void submit();
        else if (phase === "reviewing") advance();
        return;
      }
      if (phase === "answering" && current) {
        const upper = e.key.toUpperCase();
        const letterIdx = optionLetters.indexOf(upper);
        if (letterIdx >= 0 && letterIdx < current.options.length) {
          e.preventDefault();
          setSelected(letterIdx);
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [advance, current, endEarly, phase, submit]);

  const summary = useMemo(() => {
    const byTs = new Map<
      string,
      { title: string; correct: number; total: number }
    >();
    for (const a of answers) {
      const prev = byTs.get(a.taskStatementId) ?? {
        title: a.taskStatementTitle,
        correct: 0,
        total: 0,
      };
      prev.total += 1;
      if (a.success) prev.correct += 1;
      byTs.set(a.taskStatementId, prev);
    }
    const rows = Array.from(byTs.entries()).map(([id, v]) => ({
      id,
      ...v,
    }));
    rows.sort((a, b) => a.id.localeCompare(b.id));
    const correct = answers.filter((a) => a.success).length;
    return { rows, correct, total: answers.length };
  }, [answers]);

  if (phase === "done") {
    const accuracy = summary.total
      ? Math.round((summary.correct / summary.total) * 100)
      : 0;
    return (
      <section className="flex flex-col gap-6 rounded-xl border border-zinc-200 p-6 dark:border-zinc-800">
        <header className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold">Drill complete</h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            {summary.correct} / {summary.total} correct ({accuracy}%)
          </p>
        </header>

        {summary.rows.length > 0 ? (
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">
              By task statement
            </h3>
            <ul className="flex flex-col gap-1">
              {summary.rows.map((r) => (
                <li
                  key={r.id}
                  className="flex items-baseline justify-between gap-3 rounded-md border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-800"
                >
                  <span className="flex items-baseline gap-2">
                    <span className="font-mono text-xs text-zinc-500">
                      {r.id}
                    </span>
                    <span>{r.title}</span>
                  </span>
                  <span className="font-mono text-xs text-zinc-500">
                    {r.correct}/{r.total}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="flex gap-3">
          <Link
            href="/drill"
            className="rounded-full bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            Back to launcher
          </Link>
          <Link
            href="/"
            className="rounded-full border border-zinc-300 px-4 py-2 text-sm transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
          >
            Home
          </Link>
        </div>
      </section>
    );
  }

  if (!current) return null;
  const isCorrect = phase === "reviewing" && selected === current.correctIndex;
  const answered = answers.length + (phase === "reviewing" ? 0 : 0);

  return (
    <section className="flex flex-col gap-5 rounded-xl border border-zinc-200 p-6 dark:border-zinc-800">
      <header className="flex items-baseline justify-between text-xs text-zinc-500">
        <span>
          Question {index + 1} / {total}
        </span>
        <span className="flex items-baseline gap-3">
          <span>
            Score: {answers.filter((a) => a.success).length} / {answered}
          </span>
          <span className="font-mono">
            {current.taskStatementId} · L{current.bloomLevel}
          </span>
        </span>
      </header>

      <p className="text-base text-zinc-900 dark:text-zinc-100">
        {current.stem}
      </p>

      <div className="flex flex-col gap-2">
        {current.options.map((opt, i) => {
          const isRight = phase === "reviewing" && i === current.correctIndex;
          const isChosenWrong =
            phase === "reviewing" &&
            i === selected &&
            selected !== current.correctIndex;
          const isSelected = selected === i;
          return (
            <label
              key={i}
              className={`flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2 text-sm ${
                isRight
                  ? "border-green-500 bg-green-50 dark:bg-green-950/30"
                  : isChosenWrong
                    ? "border-red-500 bg-red-50 dark:bg-red-950/30"
                    : isSelected
                      ? "border-zinc-500 dark:border-zinc-400"
                      : "border-zinc-200 dark:border-zinc-800"
              }`}
            >
              <input
                type="radio"
                name={`q-${current.id}`}
                value={i}
                disabled={phase === "reviewing"}
                checked={isSelected}
                onChange={() => setSelected(i)}
                className="mt-1"
              />
              <span>
                <span className="font-mono text-xs text-zinc-500">
                  {optionLetters[i]}.
                </span>{" "}
                {opt}
              </span>
            </label>
          );
        })}
      </div>

      {phase === "reviewing" ? (
        <div className="rounded-md bg-zinc-50 p-3 text-sm text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
          <p className="mb-1 font-semibold">
            {isCorrect ? "Correct." : "Not quite."}
          </p>
          {current.explanations[current.correctIndex] ? (
            <p>{current.explanations[current.correctIndex]}</p>
          ) : null}
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-3">
        <div className="flex gap-2">
          {phase === "answering" ? (
            <button
              type="button"
              onClick={() => void submit()}
              disabled={selected === null}
              className="rounded-full bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-800 disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
            >
              Submit
            </button>
          ) : (
            <button
              type="button"
              onClick={advance}
              className="rounded-full bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
            >
              {index + 1 >= total ? "See results" : "Next"}
            </button>
          )}
          <button
            type="button"
            onClick={endEarly}
            className="rounded-full border border-zinc-300 px-4 py-2 text-sm transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
          >
            End drill
          </button>
        </div>
        <p className="text-xs text-zinc-500">
          Keys: A–{optionLetters[current.options.length - 1]} select · Enter{" "}
          {phase === "answering" ? "submit" : "next"} · Esc end
        </p>
      </div>

      {postError ? (
        <p className="text-xs text-red-600 dark:text-red-400">
          progress event failed: {postError}
        </p>
      ) : null}
    </section>
  );
}
