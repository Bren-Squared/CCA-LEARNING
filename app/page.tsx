import Link from "next/link";
import { getAppDb } from "@/lib/db";
import { buildDashboard, type WeakArea } from "@/lib/progress/dashboard";
import { computeReadiness } from "@/lib/progress/mastery";
import { buildTrendSeries } from "@/lib/progress/trend";
import { getSettingsStatus } from "@/lib/settings";
import { countDueCards } from "@/lib/study/cards";
import { countAllActiveQuestionsByCell } from "@/lib/study/drill";
import { schema } from "@/lib/db";
import BloomHeatmap from "./BloomHeatmap";
import TrendChart from "./TrendChart";

export const dynamic = "force-dynamic";

function pct(n: number): string {
  return `${n.toFixed(0)}%`;
}

function barColor(summary: number): string {
  if (summary >= 80) return "bg-green-500";
  if (summary >= 50) return "bg-amber-500";
  if (summary >= 20) return "bg-orange-500";
  return "bg-red-500";
}

function MasteryBar({ value }: { value: number }) {
  const pctValue = Math.max(0, Math.min(100, value));
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
      <div
        className={`h-full rounded-full ${barColor(pctValue)} transition-[width] duration-500`}
        style={{ width: `${pctValue}%` }}
      />
    </div>
  );
}

function CeilingPill({ ceiling }: { ceiling: WeakArea["ceiling"] }) {
  if (ceiling === 0) {
    return (
      <span className="rounded-full bg-zinc-200 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
        no ceiling
      </span>
    );
  }
  return (
    <span className="rounded-full bg-indigo-100 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-indigo-800 dark:bg-indigo-950/50 dark:text-indigo-300">
      ceiling L{ceiling}
    </span>
  );
}

export default async function Home() {
  const db = getAppDb();
  const status = getSettingsStatus(db);

  if (!status.apiKeyConfigured) {
    return (
      <main className="flex flex-1 flex-col items-center gap-8 p-8">
        <header className="flex max-w-xl flex-col items-center gap-3 text-center">
          <h1 className="text-4xl font-semibold tracking-tight">
            CCA Foundations — Learning App
          </h1>
          <p className="text-zinc-600 dark:text-zinc-400">
            Single-user study environment for the Claude Certified Architect
            Foundations exam.
          </p>
        </header>
        <div className="flex flex-col items-center gap-3">
          <p className="max-w-md text-sm text-amber-700 dark:text-amber-400">
            First run — add your Anthropic API key to enable Claude-powered
            features.
          </p>
          <Link
            href="/settings"
            className="rounded-full bg-zinc-900 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            Set up API key
          </Link>
        </div>
      </main>
    );
  }

  const dashboard = buildDashboard(db);
  const cellCounts = countAllActiveQuestionsByCell(db);
  const trend = buildTrendSeries(db);
  const dueFlashcards = countDueCards({ db });
  const totalFlashcards = db.select({ id: schema.flashcards.id }).from(schema.flashcards).all().length;
  const readiness = computeReadiness(
    dashboard.domains.map((d) => ({
      summary: d.summary,
      weightBps: d.weightBps,
    })),
  );

  return (
    <main className="flex flex-1 flex-col items-center px-6 py-10">
      <div className="flex w-full max-w-5xl flex-col gap-8">
        <header className="flex flex-col gap-3">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h1 className="text-3xl font-semibold tracking-tight">
              CCA Foundations
            </h1>
            <div className="flex items-baseline gap-4 text-sm">
              <span className="text-green-700 dark:text-green-400">
                {status.apiKeyRedacted} · {status.defaultModel}
              </span>
              <Link href="/drill" className="text-zinc-600 underline dark:text-zinc-400">
                Drill
              </Link>
              <Link
                href="/study/tutor"
                className="text-zinc-600 underline dark:text-zinc-400"
              >
                Tutor
              </Link>
              <Link
                href="/study/scenarios"
                className="text-zinc-600 underline dark:text-zinc-400"
              >
                Scenarios
              </Link>
              <Link
                href="/mock"
                className="text-zinc-600 underline dark:text-zinc-400"
              >
                Mock Exam
              </Link>
              <Link
                href="/study/exercises"
                className="text-zinc-600 underline dark:text-zinc-400"
              >
                Exercises
              </Link>
              <Link
                href="/study/flashcards"
                className="text-zinc-600 underline dark:text-zinc-400"
              >
                Flashcards
                {dueFlashcards > 0 ? (
                  <span className="ml-1 rounded-full bg-indigo-600 px-1.5 py-0.5 font-mono text-[10px] text-white">
                    {dueFlashcards}
                  </span>
                ) : null}
              </Link>
              <Link
                href="/admin/coverage"
                className="text-zinc-600 underline dark:text-zinc-400"
              >
                Coverage
              </Link>
              <Link
                href="/settings"
                className="text-zinc-600 underline dark:text-zinc-400"
              >
                Settings
              </Link>
            </div>
          </div>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Readiness {pct(readiness)} · overall {pct(dashboard.totals.overallSummary)}{" "}
            · mastered {dashboard.totals.masteredCells}/{dashboard.totals.totalCells}{" "}
            Bloom cells across {dashboard.totals.activeTaskStatements} task
            statements.
          </p>
        </header>

        <section className="flex flex-col gap-4">
          <h2 className="text-sm font-mono uppercase tracking-widest text-zinc-500">
            Mastery by domain
          </h2>
          <ul className="flex flex-col gap-4">
            {dashboard.domains.map((d) => {
              const mastered = d.taskStatements.reduce(
                (a, t) => a + t.levels.filter((l) => l.mastered).length,
                0,
              );
              const cellsTotal = d.taskStatements.length * 6;
              return (
                <li key={d.domainId} className="flex flex-col gap-2">
                  <div className="flex items-baseline justify-between gap-3 text-sm">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <span className="font-mono text-xs text-zinc-500">
                        {d.domainId}
                      </span>
                      <span className="text-zinc-800 dark:text-zinc-200">
                        {d.title}
                      </span>
                      <span className="font-mono text-[10px] uppercase tracking-wider text-zinc-500">
                        weight {(d.weightBps / 100).toFixed(0)}%
                      </span>
                    </div>
                    <div className="flex items-baseline gap-3 font-mono text-xs text-zinc-600 dark:text-zinc-400">
                      <span>{pct(d.summary)}</span>
                      <span className="text-zinc-500">
                        {mastered}/{cellsTotal}
                      </span>
                    </div>
                  </div>
                  <MasteryBar value={d.summary} />
                </li>
              );
            })}
          </ul>
        </section>

        <section className="flex flex-col gap-4 rounded-xl border border-zinc-200 p-5 dark:border-zinc-800">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-sm font-mono uppercase tracking-widest text-zinc-500">
              Weak areas (AT8)
            </h2>
            <span className="text-xs text-zinc-500">
              gap × domain weight · top {dashboard.weakAreas.length}
            </span>
          </div>
          {dashboard.weakAreas.length === 0 ? (
            <p className="text-sm text-zinc-500">No task statements yet.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {dashboard.weakAreas.map((w) => (
                <li
                  key={w.taskStatementId}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-800"
                >
                  <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-2">
                    <span className="font-mono text-xs text-zinc-500">
                      {w.taskStatementId}
                    </span>
                    <span className="truncate text-zinc-800 dark:text-zinc-200">
                      {w.title}
                    </span>
                    <CeilingPill ceiling={w.ceiling} />
                  </div>
                  <div className="flex items-baseline gap-3 font-mono text-xs">
                    <span className="text-zinc-600 dark:text-zinc-400">
                      {pct(w.summary)}
                    </span>
                    <span className="text-zinc-500">
                      prio {w.priority.toFixed(1)}
                    </span>
                    <Link
                      href={`/study/task/${encodeURIComponent(w.taskStatementId)}`}
                      className="text-indigo-600 underline dark:text-indigo-400"
                    >
                      Open
                    </Link>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <TrendChart series={trend} readiness={readiness} />

        <BloomHeatmap domains={dashboard.domains} cellCounts={cellCounts} />

        <section className="grid gap-5 md:grid-cols-2">
          <LastSession recap={dashboard.lastSession} />
          <FlashcardsCard due={dueFlashcards} total={totalFlashcards} />
        </section>

        <section className="flex flex-col gap-4">
          <h2 className="text-sm font-mono uppercase tracking-widest text-zinc-500">
            All task statements
          </h2>
          <div className="flex flex-col gap-4">
            {dashboard.domains.map((d) => (
              <div key={d.domainId} className="flex flex-col gap-2">
                <h3 className="text-xs font-mono uppercase tracking-widest text-zinc-500">
                  {d.domainId} · {d.title}
                </h3>
                <ul className="flex flex-col gap-1">
                  {d.taskStatements.map((t) => (
                    <li key={t.taskStatementId}>
                      <Link
                        href={`/study/task/${encodeURIComponent(t.taskStatementId)}`}
                        className="flex items-baseline justify-between gap-3 rounded-md px-3 py-2 text-sm text-zinc-700 transition-colors hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-900"
                      >
                        <div className="flex flex-wrap items-baseline gap-2">
                          <span className="font-mono text-xs text-zinc-500">
                            {t.taskStatementId}
                          </span>
                          <span>{t.title}</span>
                        </div>
                        <div className="flex items-baseline gap-3 font-mono text-xs text-zinc-500">
                          <span>{pct(t.summary)}</span>
                          <span>
                            {t.ceiling === 0 ? "—" : `L${t.ceiling}`}
                          </span>
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}

function LastSession({
  recap,
}: {
  recap: ReturnType<typeof buildDashboard>["lastSession"];
}) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-zinc-200 p-5 dark:border-zinc-800">
      <h2 className="text-sm font-mono uppercase tracking-widest text-zinc-500">
        Last session
      </h2>
      {recap.totalEvents === 0 ? (
        <p className="text-sm text-zinc-500">
          No progress recorded yet. Start a drill to build your mastery map.
        </p>
      ) : (
        <div className="flex flex-col gap-2 text-sm">
          <p className="text-zinc-600 dark:text-zinc-400">
            {recap.successCount}/{recap.totalEvents} correct across{" "}
            {recap.uniqueCells} Bloom cell{recap.uniqueCells === 1 ? "" : "s"}
            {recap.date
              ? ` · ${new Date(recap.date).toLocaleString()}`
              : null}
          </p>
          <ul className="flex flex-col gap-1">
            {recap.events.slice(0, 5).map((e) => (
              <li
                key={e.id}
                className="flex items-baseline gap-2 font-mono text-xs text-zinc-500"
              >
                <span
                  className={
                    e.success
                      ? "text-green-600 dark:text-green-400"
                      : "text-red-600 dark:text-red-400"
                  }
                >
                  {e.success ? "✓" : "✗"}
                </span>
                <span className="truncate text-zinc-700 dark:text-zinc-300">
                  {e.taskStatementId} L{e.bloomLevel}
                </span>
                <span>{e.kind}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function FlashcardsCard({ due, total }: { due: number; total: number }) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-zinc-200 p-5 dark:border-zinc-800">
      <h2 className="text-sm font-mono uppercase tracking-widest text-zinc-500">
        Flashcards
      </h2>
      {total === 0 ? (
        <p className="text-sm text-zinc-500">
          No deck yet. Run{" "}
          <code className="rounded bg-zinc-100 px-1 font-mono text-xs dark:bg-zinc-900">
            npm run seed:flashcards
          </code>{" "}
          to generate one card set per task statement.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            {due === 0 ? (
              <>
                {total} card{total === 1 ? "" : "s"} in deck ·{" "}
                <span className="text-green-700 dark:text-green-400">
                  none due right now
                </span>
              </>
            ) : (
              <>
                <span className="font-semibold text-indigo-700 dark:text-indigo-400">
                  {due} card{due === 1 ? "" : "s"} due
                </span>{" "}
                · {total} total
              </>
            )}
          </p>
          <Link
            href="/study/flashcards"
            className="self-start rounded-full bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-700"
          >
            {due > 0 ? "Start review" : "Open queue"}
          </Link>
        </div>
      )}
    </div>
  );
}
