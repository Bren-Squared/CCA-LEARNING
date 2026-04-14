import { eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getAppDb, schema } from "@/lib/db";
import { buildTaskStatementRollup } from "@/lib/progress/dashboard";
import type { BloomLevel } from "@/lib/progress/mastery";
import { hasApiKey } from "@/lib/settings";
import { countQuestionsForTaskByLevel } from "@/lib/study/drill";
import { readExplainerCache } from "@/lib/study/explainer";
import StudyTaskDetail from "./StudyTaskDetail";

export const dynamic = "force-dynamic";

const BLOOM_LABELS: Record<BloomLevel, string> = {
  1: "Remember",
  2: "Understand",
  3: "Apply",
  4: "Analyze",
  5: "Evaluate",
  6: "Create",
};

function drillHref(tsId: string, bloom: BloomLevel): string {
  return `/drill/run?scope=task&id=${encodeURIComponent(tsId)}&bloom=${bloom}`;
}

function scoreColor(score: number, mastered: boolean): string {
  if (mastered) return "bg-green-500";
  if (score >= 0.5) return "bg-amber-500";
  if (score > 0) return "bg-orange-500";
  return "bg-zinc-300 dark:bg-zinc-700";
}

export default async function TaskStatementPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const db = getAppDb();

  const ts = db
    .select()
    .from(schema.taskStatements)
    .where(eq(schema.taskStatements.id, id))
    .get();
  if (!ts) notFound();

  const domain = db
    .select()
    .from(schema.domains)
    .where(eq(schema.domains.id, ts.domainId))
    .get();

  const cached = readExplainerCache(id, db);
  const keyConfigured = hasApiKey(db);
  const rollup = buildTaskStatementRollup(id, db);
  const questionCounts = countQuestionsForTaskByLevel(id, db);

  return (
    <main className="flex flex-1 flex-col items-center px-6 py-12">
      <div className="flex w-full max-w-3xl flex-col gap-8">
        <header className="flex flex-col gap-2">
          <p className="text-xs font-mono uppercase tracking-widest text-zinc-500">
            {domain ? `${domain.id} · ${domain.title}` : ts.domainId}
          </p>
          <h1 className="text-3xl font-semibold tracking-tight">{ts.title}</h1>
          <p className="text-xs font-mono text-zinc-500">{ts.id}</p>
        </header>

        {rollup ? (
          <BloomLadder
            rollup={rollup}
            questionCounts={questionCounts}
            taskStatementId={ts.id}
          />
        ) : null}

        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">Knowledge</h2>
          <ul className="flex flex-col gap-2 text-sm text-zinc-700 dark:text-zinc-300">
            {ts.knowledgeBullets.map((b, i) => (
              <li key={i} className="flex gap-2">
                <span className="text-zinc-400">•</span>
                <span>{b}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">Skills</h2>
          <ul className="flex flex-col gap-2 text-sm text-zinc-700 dark:text-zinc-300">
            {ts.skillsBullets.map((b, i) => (
              <li key={i} className="flex gap-2">
                <span className="text-zinc-400">•</span>
                <span>{b}</span>
              </li>
            ))}
          </ul>
        </section>

        <StudyTaskDetail
          taskStatementId={ts.id}
          initialArtifact={cached}
          apiKeyConfigured={keyConfigured}
        />
      </div>
    </main>
  );
}

function BloomLadder({
  rollup,
  questionCounts,
  taskStatementId,
}: {
  rollup: NonNullable<ReturnType<typeof buildTaskStatementRollup>>;
  questionCounts: Record<BloomLevel, number>;
  taskStatementId: string;
}) {
  const { ceiling, nextLevel, levels, summary, totalItems } = rollup;
  const targetCount = questionCounts[nextLevel];

  return (
    <section className="flex flex-col gap-4 rounded-xl border border-zinc-200 p-5 dark:border-zinc-800">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="text-sm font-mono uppercase tracking-widest text-zinc-500">
            Bloom ladder
          </h2>
          <p className="text-xs text-zinc-500">
            Summary {summary.toFixed(0)}% · {totalItems} answered ·{" "}
            {ceiling === 0 ? "no ceiling yet" : `ceiling L${ceiling}`}
          </p>
        </div>
        {targetCount > 0 ? (
          <Link
            href={drillHref(taskStatementId, nextLevel)}
            className="rounded-full bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            Drill at L{nextLevel} · {BLOOM_LABELS[nextLevel]}
          </Link>
        ) : (
          <span className="text-xs text-zinc-500">
            No L{nextLevel} questions yet — generate via /admin/coverage
          </span>
        )}
      </div>

      <ul className="flex flex-col gap-1.5">
        {levels.map((l) => {
          const count = questionCounts[l.level];
          const scorePct = Math.round(l.score * 100);
          const isCeiling = l.level === ceiling;
          const isNext = l.level === nextLevel && ceiling !== 6;
          return (
            <li
              key={l.level}
              className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm ${
                isNext
                  ? "bg-indigo-50 dark:bg-indigo-950/30"
                  : "hover:bg-zinc-50 dark:hover:bg-zinc-900"
              }`}
            >
              <span className="w-8 font-mono text-xs text-zinc-500">
                L{l.level}
              </span>
              <span className="w-24 text-xs text-zinc-600 dark:text-zinc-400">
                {BLOOM_LABELS[l.level]}
              </span>
              <div className="h-2 w-32 shrink-0 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
                <div
                  className={`h-full rounded-full ${scoreColor(l.score, l.mastered)}`}
                  style={{ width: `${scorePct}%` }}
                />
              </div>
              <span className="w-14 font-mono text-xs text-zinc-600 dark:text-zinc-400">
                {scorePct}%
              </span>
              <span className="w-14 font-mono text-xs text-zinc-500">
                n={l.itemCount}
              </span>
              {l.mastered ? (
                <span className="rounded-full bg-green-100 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-green-800 dark:bg-green-950/40 dark:text-green-300">
                  mastered
                </span>
              ) : null}
              {isCeiling ? (
                <span className="rounded-full bg-indigo-100 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-indigo-800 dark:bg-indigo-950/40 dark:text-indigo-300">
                  ceiling
                </span>
              ) : null}
              <span className="ml-auto flex items-center gap-2 text-xs text-zinc-500">
                <span className="font-mono">{count} q</span>
                {count > 0 ? (
                  <Link
                    href={drillHref(taskStatementId, l.level)}
                    className="text-indigo-600 underline dark:text-indigo-400"
                  >
                    Drill
                  </Link>
                ) : (
                  <span>—</span>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
