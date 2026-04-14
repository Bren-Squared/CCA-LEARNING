"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

/**
 * Flashcard review queue (AT3). The queue is front-loaded from the server —
 * we just pop cards off the client-side array as the user grades them. Each
 * grade POSTs to /api/flashcards/grade which writes the SM-2 update and the
 * progress event in one transaction; on success we remove the card from the
 * visible queue. No re-fetch until the user returns to the page, so the
 * session state is entirely local.
 *
 * Keyboard shortcuts (NFR5.2):
 *   space      flip front ↔ back
 *   1          again   (failure — restart interval)
 *   2          hard
 *   3          good
 *   4          easy
 */

type Grade = "again" | "hard" | "good" | "easy";

interface QueueCard {
  id: string;
  taskStatementId: string;
  front: string;
  back: string;
  bloomLevel: number;
  intervalDays: number;
  dueAt: number;
  reviewsCount: number;
}

interface CompletedCard {
  cardId: string;
  grade: Grade;
  intervalDays: number;
  dueAt: number;
  taskStatementId: string;
}

const GRADE_BUTTONS: Array<{
  grade: Grade;
  label: string;
  shortcut: string;
  tone: string;
}> = [
  { grade: "again", label: "Again", shortcut: "1", tone: "bg-red-100 text-red-900 hover:bg-red-200 dark:bg-red-950/40 dark:text-red-200 dark:hover:bg-red-950/60" },
  { grade: "hard", label: "Hard", shortcut: "2", tone: "bg-orange-100 text-orange-900 hover:bg-orange-200 dark:bg-orange-950/40 dark:text-orange-200 dark:hover:bg-orange-950/60" },
  { grade: "good", label: "Good", shortcut: "3", tone: "bg-green-100 text-green-900 hover:bg-green-200 dark:bg-green-950/40 dark:text-green-200 dark:hover:bg-green-950/60" },
  { grade: "easy", label: "Easy", shortcut: "4", tone: "bg-indigo-100 text-indigo-900 hover:bg-indigo-200 dark:bg-indigo-950/40 dark:text-indigo-200 dark:hover:bg-indigo-950/60" },
];

function formatNextDue(dueAtMs: number): string {
  const ms = dueAtMs - Date.now();
  if (ms <= 60_000) return "now";
  const days = ms / (1000 * 60 * 60 * 24);
  if (days >= 1) return `${days.toFixed(days < 10 ? 1 : 0)}d`;
  const hours = ms / (1000 * 60 * 60);
  if (hours >= 1) return `${hours.toFixed(0)}h`;
  return `${Math.round(ms / 60_000)}m`;
}

export default function FlashcardReview({ queue }: { queue: QueueCard[] }) {
  const [remaining, setRemaining] = useState<QueueCard[]>(queue);
  const [completed, setCompleted] = useState<CompletedCard[]>([]);
  const [flipped, setFlipped] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const current = remaining[0];
  const done = useMemo(() => completed.length, [completed.length]);
  const total = queue.length;

  const submitGrade = useCallback(
    async (grade: Grade) => {
      if (!current || submitting) return;
      setSubmitting(true);
      setError(null);
      try {
        const res = await fetch("/api/flashcards/grade", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ cardId: current.id, grade }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? `grade failed (${res.status})`);
        }
        const result = (await res.json()) as {
          intervalDays: number;
          dueAt: string | number;
        };
        const dueAtMs =
          typeof result.dueAt === "string"
            ? new Date(result.dueAt).getTime()
            : result.dueAt;
        setCompleted((c) => [
          ...c,
          {
            cardId: current.id,
            grade,
            intervalDays: result.intervalDays,
            dueAt: dueAtMs,
            taskStatementId: current.taskStatementId,
          },
        ]);
        setRemaining((q) => q.slice(1));
        setFlipped(false);
      } catch (e) {
        setError(e instanceof Error ? e.message : "unknown error");
      } finally {
        setSubmitting(false);
      }
    },
    [current, submitting],
  );

  // Keyboard shortcuts
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }
      if (e.key === " " || e.code === "Space") {
        e.preventDefault();
        setFlipped((f) => !f);
        return;
      }
      if (!flipped) return;
      const match = GRADE_BUTTONS.find((b) => b.shortcut === e.key);
      if (match) {
        e.preventDefault();
        void submitGrade(match.grade);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [flipped, submitGrade]);

  if (!current) {
    return (
      <section className="flex flex-col gap-4 rounded-xl border border-zinc-200 p-6 dark:border-zinc-800">
        <h2 className="text-lg font-semibold">Session complete</h2>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          {done} card{done === 1 ? "" : "s"} reviewed. Mastery snapshots have
          been updated — check the dashboard trend chart.
        </p>
        <ul className="flex flex-col gap-1 font-mono text-xs">
          {completed.map((c) => (
            <li
              key={c.cardId}
              className="flex items-baseline justify-between text-zinc-500"
            >
              <span className="truncate">
                <span
                  className={
                    c.grade === "again"
                      ? "text-red-600 dark:text-red-400"
                      : c.grade === "hard"
                        ? "text-orange-600 dark:text-orange-400"
                        : c.grade === "good"
                          ? "text-green-600 dark:text-green-400"
                          : "text-indigo-600 dark:text-indigo-400"
                  }
                >
                  {c.grade}
                </span>{" "}
                · {c.taskStatementId}
              </span>
              <span>next in {formatNextDue(c.dueAt)}</span>
            </li>
          ))}
        </ul>
        <div className="flex gap-2">
          <Link
            href="/"
            className="rounded-full border border-zinc-300 px-4 py-2 text-sm transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
          >
            Back to dashboard
          </Link>
          <Link
            href="/study/flashcards"
            className="rounded-full bg-zinc-900 px-4 py-2 text-sm text-white transition-colors hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            Check for more
          </Link>
        </div>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-baseline justify-between text-xs text-zinc-500">
        <span className="font-mono">
          {done + 1} / {total}
        </span>
        <span className="font-mono">
          {current.taskStatementId} · Bloom L{current.bloomLevel} · reviews{" "}
          {current.reviewsCount}
        </span>
      </div>

      <button
        type="button"
        onClick={() => setFlipped((f) => !f)}
        className="group flex min-h-[220px] flex-col items-start justify-center gap-3 rounded-xl border border-zinc-200 bg-white p-6 text-left transition-transform duration-200 hover:-translate-y-0.5 dark:border-zinc-800 dark:bg-zinc-950"
        aria-label={flipped ? "Show front (prompt)" : "Show back (answer)"}
      >
        <span className="font-mono text-[10px] uppercase tracking-wider text-zinc-400">
          {flipped ? "Answer" : "Prompt"}
        </span>
        <p className="whitespace-pre-wrap text-base leading-relaxed text-zinc-900 dark:text-zinc-100">
          {flipped ? current.back : current.front}
        </p>
        {!flipped && (
          <span className="mt-auto text-xs text-zinc-500">
            Tap card or press{" "}
            <kbd className="rounded bg-zinc-200 px-1 font-mono dark:bg-zinc-800">
              space
            </kbd>{" "}
            to reveal
          </span>
        )}
      </button>

      {flipped ? (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {GRADE_BUTTONS.map((b) => (
            <button
              key={b.grade}
              type="button"
              disabled={submitting}
              onClick={() => void submitGrade(b.grade)}
              className={`flex flex-col items-center justify-center gap-1 rounded-lg px-3 py-3 text-sm font-medium transition-colors disabled:opacity-50 ${b.tone}`}
            >
              <span>{b.label}</span>
              <span className="font-mono text-[10px] opacity-70">
                {b.shortcut}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <p className="text-center text-xs text-zinc-500">
          Try to recall the answer before revealing. Grades unlock after flip.
        </p>
      )}

      {error && (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
          {error}
        </p>
      )}
    </section>
  );
}
