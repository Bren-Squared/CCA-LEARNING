import Link from "next/link";
import { getAppDb } from "@/lib/db";
import {
  MOCK_DURATION_MS,
  MOCK_PASS_SCALED,
  MOCK_SCALED_MAX,
  MOCK_SCALED_MIN,
  listMockAttempts,
} from "@/lib/mock/attempts";
import { countAllActiveQuestionsByCell } from "@/lib/study/drill";
import MockStartButton from "./MockStartButton";

export const dynamic = "force-dynamic";

function scaledBadgeColor(scaled: number | null): string {
  if (scaled === null) return "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300";
  if (scaled >= MOCK_PASS_SCALED)
    return "bg-green-100 text-green-800 dark:bg-green-950/40 dark:text-green-300";
  return "bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-300";
}

function formatDuration(ms: number): string {
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

function formatAbsoluteMs(ms: number | null): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString();
}

export default function MockExamIndexPage() {
  const db = getAppDb();
  const attempts = listMockAttempts({ db });

  const cellCounts = countAllActiveQuestionsByCell(db);
  let examBandQuestions = 0;
  for (const [key, count] of cellCounts) {
    const level = Number(key.split("|")[1]);
    if (level >= 3 && level <= 5) examBandQuestions += count;
  }
  const canStart = examBandQuestions >= 60;

  return (
    <main className="mx-auto max-w-5xl px-6 py-10 font-sans text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <header className="mb-8 flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Mock Exam</h1>
        <Link href="/" className="text-sm text-zinc-600 underline dark:text-zinc-400">
          ← Dashboard
        </Link>
      </header>

      <section className="mb-10 rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="text-lg font-semibold">Start a new attempt</h2>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          60 questions · {formatDuration(MOCK_DURATION_MS)} · 4 of 6 scenarios at random ·
          Apply–Evaluate Bloom band only. Timer runs from the moment you start and
          does not pause. Unanswered questions are marked incorrect (matches the real
          exam).
        </p>
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-500">
          Scaled score range {MOCK_SCALED_MIN}–{MOCK_SCALED_MAX}; pass line at{" "}
          {MOCK_PASS_SCALED}. Anthropic does not publish the exam&apos;s raw-to-scaled
          formula — scores here are an approximation for practice only (RD2).
        </p>
        {!canStart ? (
          <p className="mt-4 rounded-md bg-amber-100 p-3 text-sm text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
            Only {examBandQuestions} active Apply–Evaluate questions in the bank — a
            mock attempt needs 60. Generate more via{" "}
            <Link href="/admin/coverage" className="underline">
              Coverage
            </Link>{" "}
            before starting.
          </p>
        ) : (
          <div className="mt-4">
            <MockStartButton />
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">Attempt history</h2>
        {attempts.length === 0 ? (
          <p className="rounded-lg border border-dashed border-zinc-300 p-8 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-500">
            No attempts yet.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {attempts.map((a) => {
              const ongoing = a.status === "in_progress";
              return (
                <li
                  key={a.id}
                  className="flex items-center justify-between gap-4 rounded-lg border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900"
                >
                  <div className="flex flex-col">
                    <span className="text-sm font-medium">
                      {formatAbsoluteMs(a.startedAt)}
                    </span>
                    <span className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                      {a.status === "in_progress"
                        ? "in progress"
                        : a.status === "timeout"
                          ? "timed out"
                          : "submitted"}
                      {a.rawScore !== null ? ` · ${a.rawScore}/60 raw` : ""}
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    {a.scaledScore !== null ? (
                      <span
                        className={`rounded-full px-3 py-1 font-mono text-xs ${scaledBadgeColor(a.scaledScore)}`}
                      >
                        {a.scaledScore} {a.passed ? "PASS" : "FAIL"}
                      </span>
                    ) : null}
                    {ongoing ? (
                      <Link
                        href={`/mock/${a.id}`}
                        className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500"
                      >
                        Resume
                      </Link>
                    ) : (
                      <Link
                        href={`/mock/${a.id}/review`}
                        className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-semibold text-zinc-900 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
                      >
                        Review
                      </Link>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </main>
  );
}
