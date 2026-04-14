"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

export interface ExamQuestion {
  index: number;
  id: string;
  stem: string;
  options: string[];
  taskStatementId: string;
  taskStatementTitle: string;
  domainId: string;
  bloomLevel: number;
}

interface MockExamRunnerProps {
  attemptId: string;
  startedAt: number;
  durationMs: number;
  initialAnswers: Array<number | null>;
  questions: ExamQuestion[];
}

function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60)
    .toString()
    .padStart(2, "0");
  const s = (total % 60).toString().padStart(2, "0");
  return h > 0 ? `${h}:${m}:${s}` : `${m}:${s}`;
}

export default function MockExamRunner(props: MockExamRunnerProps) {
  const router = useRouter();
  const { attemptId, startedAt, durationMs, initialAnswers, questions } = props;

  const deadline = startedAt + durationMs;
  const [answers, setAnswers] = useState<Array<number | null>>(() =>
    initialAnswers.slice(),
  );
  const [current, setCurrent] = useState(0);
  const [remainingMs, setRemainingMs] = useState(() =>
    Math.max(0, deadline - Date.now()),
  );
  const [saving, setSaving] = useState<"idle" | "saving" | "error">("idle");
  const [submitting, setSubmitting] = useState(false);
  const autosaveTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const totalAnswered = answers.filter((a) => a !== null).length;

  const submitFinish = useCallback(async () => {
    setSubmitting(true);
    try {
      await fetch(`/api/mock/${attemptId}/finish`, { method: "POST" });
    } finally {
      router.push(`/mock/${attemptId}/review`);
      router.refresh();
    }
  }, [attemptId, router]);

  // Tick the timer once per second, anchored to the server-provided deadline
  // so we survive tab suspend / clock drift within the 1s NFR1.3 budget.
  useEffect(() => {
    const tick = () => {
      const left = Math.max(0, deadline - Date.now());
      setRemainingMs(left);
      if (left <= 0) {
        submitFinish();
      }
    };
    tick();
    const handle = setInterval(tick, 1000);
    return () => clearInterval(handle);
  }, [deadline, submitFinish]);

  const persistAnswer = useCallback(
    async (qIdx: number, optionIdx: number | null) => {
      setSaving("saving");
      try {
        const resp = await fetch(`/api/mock/${attemptId}/answer`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ qIdx, optionIdx }),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        setSaving("idle");
      } catch {
        setSaving("error");
      }
    },
    [attemptId],
  );

  const pick = useCallback(
    (optionIdx: number) => {
      setAnswers((prev) => {
        const next = prev.slice();
        next[current] = optionIdx;
        return next;
      });
      if (autosaveTimeout.current) clearTimeout(autosaveTimeout.current);
      autosaveTimeout.current = setTimeout(
        () => persistAnswer(current, optionIdx),
        0,
      );
    },
    [current, persistAnswer],
  );

  const clearAnswer = useCallback(() => {
    setAnswers((prev) => {
      const next = prev.slice();
      next[current] = null;
      return next;
    });
    persistAnswer(current, null);
  }, [current, persistAnswer]);

  const goPrev = useCallback(() => setCurrent((i) => Math.max(0, i - 1)), []);
  const goNext = useCallback(
    () => setCurrent((i) => Math.min(questions.length - 1, i + 1)),
    [questions.length],
  );

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        goPrev();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        goNext();
      } else if (e.key >= "1" && e.key <= "4") {
        e.preventDefault();
        pick(Number(e.key) - 1);
      } else if (e.key === "Backspace" || e.key === "0") {
        e.preventDefault();
        clearAnswer();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goPrev, goNext, pick, clearAnswer]);

  const q = questions[current];
  const timerWarn = remainingMs <= 5 * 60 * 1000;
  const timerCritical = remainingMs <= 60 * 1000;

  return (
    <div className="flex flex-col gap-6">
      <header className="sticky top-0 z-10 -mx-6 border-b border-zinc-200 bg-white/95 px-6 py-3 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/95">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-4">
          <div className="flex flex-col">
            <span className="text-xs uppercase tracking-wider text-zinc-500">
              Mock exam
            </span>
            <span className="text-sm font-medium">
              Question {current + 1} of {questions.length} · {totalAnswered}{" "}
              answered
            </span>
          </div>
          <div className="flex items-center gap-4">
            <span
              className={`rounded-md px-3 py-1 font-mono text-lg tabular-nums ${
                timerCritical
                  ? "bg-red-100 text-red-900 dark:bg-red-950/50 dark:text-red-200"
                  : timerWarn
                    ? "bg-amber-100 text-amber-900 dark:bg-amber-950/50 dark:text-amber-200"
                    : "bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100"
              }`}
              aria-label="time remaining"
            >
              {formatRemaining(remainingMs)}
            </span>
            <span className="text-xs text-zinc-500">
              {saving === "saving"
                ? "Saving…"
                : saving === "error"
                  ? "Save failed — will retry"
                  : "Saved"}
            </span>
            <button
              type="button"
              onClick={submitFinish}
              disabled={submitting}
              className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-60"
            >
              {submitting ? "Submitting…" : "Submit"}
            </button>
          </div>
        </div>
      </header>

      <section className="rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mb-3 flex flex-wrap items-baseline gap-2 text-xs text-zinc-500">
          <span>{q.domainId}</span>
          <span>·</span>
          <span>{q.taskStatementId}</span>
          <span className="ml-2 rounded-full bg-zinc-100 px-2 py-0.5 font-mono dark:bg-zinc-800">
            Bloom L{q.bloomLevel}
          </span>
        </div>
        <p className="whitespace-pre-wrap text-base leading-relaxed">{q.stem}</p>
        <ol className="mt-5 flex flex-col gap-2" aria-label="answer options">
          {q.options.map((opt, i) => {
            const selected = answers[current] === i;
            return (
              <li key={i}>
                <button
                  type="button"
                  onClick={() => pick(i)}
                  className={`group flex w-full items-start gap-3 rounded-lg border px-4 py-3 text-left text-sm transition ${
                    selected
                      ? "border-indigo-600 bg-indigo-50 dark:border-indigo-400 dark:bg-indigo-950/30"
                      : "border-zinc-200 bg-white hover:border-zinc-400 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-600"
                  }`}
                >
                  <span
                    className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full font-mono text-xs ${
                      selected
                        ? "bg-indigo-600 text-white"
                        : "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                    }`}
                  >
                    {i + 1}
                  </span>
                  <span className="flex-1 whitespace-pre-wrap">{opt}</span>
                </button>
              </li>
            );
          })}
        </ol>
        <div className="mt-4 flex items-center gap-2 text-xs text-zinc-500">
          <kbd className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono dark:bg-zinc-800">
            1
          </kbd>
          –
          <kbd className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono dark:bg-zinc-800">
            4
          </kbd>
          <span>pick ·</span>
          <kbd className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono dark:bg-zinc-800">
            ←
          </kbd>
          <kbd className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono dark:bg-zinc-800">
            →
          </kbd>
          <span>navigate ·</span>
          <kbd className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono dark:bg-zinc-800">
            0
          </kbd>
          <span>clear</span>
        </div>
      </section>

      <nav className="flex items-center justify-between">
        <button
          type="button"
          onClick={goPrev}
          disabled={current === 0}
          className="rounded-md border border-zinc-300 bg-white px-4 py-2 text-sm font-semibold text-zinc-900 hover:bg-zinc-50 disabled:opacity-40 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
        >
          ← Previous
        </button>
        <button
          type="button"
          onClick={goNext}
          disabled={current === questions.length - 1}
          className="rounded-md border border-zinc-300 bg-white px-4 py-2 text-sm font-semibold text-zinc-900 hover:bg-zinc-50 disabled:opacity-40 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
        >
          Next →
        </button>
      </nav>

      <QuestionGrid
        current={current}
        answers={answers}
        onJump={setCurrent}
      />
    </div>
  );
}

function QuestionGrid(props: {
  current: number;
  answers: Array<number | null>;
  onJump: (idx: number) => void;
}) {
  const { current, answers, onJump } = props;
  const cells = useMemo(
    () =>
      answers.map((a, i) => ({
        idx: i,
        answered: a !== null,
        active: i === current,
      })),
    [answers, current],
  );
  return (
    <section>
      <h2 className="mb-2 text-xs uppercase tracking-wider text-zinc-500">
        Question map
      </h2>
      <div className="grid grid-cols-10 gap-1.5">
        {cells.map((c) => (
          <button
            key={c.idx}
            type="button"
            onClick={() => onJump(c.idx)}
            className={`rounded-md px-1.5 py-1 text-center font-mono text-xs transition ${
              c.active
                ? "ring-2 ring-indigo-500"
                : c.answered
                  ? "bg-indigo-100 text-indigo-900 dark:bg-indigo-950/40 dark:text-indigo-200"
                  : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
            }`}
          >
            {c.idx + 1}
          </button>
        ))}
      </div>
    </section>
  );
}
