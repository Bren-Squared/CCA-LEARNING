import { asc } from "drizzle-orm";
import Link from "next/link";
import { getAppDb, schema } from "@/lib/db";
import { countQuestionsByScope, DEFAULT_DRILL_LIMIT } from "@/lib/study/drill";

export const dynamic = "force-dynamic";

function runHref(scopeType: string, id?: string): string {
  const q = new URLSearchParams({ scope: scopeType });
  if (id) q.set("id", id);
  return `/drill/run?${q.toString()}`;
}

function shortageNote(count: number): string | null {
  if (count === 0) return "no questions yet";
  if (count < DEFAULT_DRILL_LIMIT) return `only ${count} — Phase 6 fills this in`;
  return null;
}

export default async function DrillLauncherPage() {
  const db = getAppDb();
  const counts = countQuestionsByScope(db);
  const domains = db
    .select()
    .from(schema.domains)
    .orderBy(asc(schema.domains.orderIndex))
    .all();
  const taskStatements = db
    .select()
    .from(schema.taskStatements)
    .orderBy(asc(schema.taskStatements.orderIndex))
    .all();
  const scenarios = db
    .select()
    .from(schema.scenarios)
    .orderBy(asc(schema.scenarios.orderIndex))
    .all();

  const domainCount = (id: string) =>
    counts.byDomain.find((c) => c.key === id)?.count ?? 0;
  const tsCount = (id: string) =>
    counts.byTaskStatement.find((c) => c.key === id)?.count ?? 0;
  const scenarioCount = (id: string) =>
    counts.byScenario.find((c) => c.key === id)?.count ?? 0;

  return (
    <main className="flex flex-1 flex-col items-center px-6 py-12">
      <div className="flex w-full max-w-3xl flex-col gap-8">
        <header className="flex flex-col gap-2">
          <p className="text-xs font-mono uppercase tracking-widest text-zinc-500">
            Drill
          </p>
          <h1 className="text-3xl font-semibold tracking-tight">
            Practice questions
          </h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Pick a scope — you&apos;ll see {DEFAULT_DRILL_LIMIT} questions or
            whatever&apos;s available, shuffled. Each answer writes a progress
            event at the question&apos;s Bloom level.
          </p>
        </header>

        <section className="flex flex-col gap-3 rounded-xl border border-zinc-200 p-6 dark:border-zinc-800">
          <h2 className="text-lg font-semibold">Everything</h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            {counts.total} active questions across the whole bank.
          </p>
          <Link
            href={runHref("all")}
            className="self-start rounded-full bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            Start mixed drill
          </Link>
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">By domain</h2>
          <ul className="flex flex-col gap-2">
            {domains.map((d) => {
              const n = domainCount(d.id);
              const note = shortageNote(n);
              return (
                <li
                  key={d.id}
                  className="flex items-center justify-between rounded-md border border-zinc-200 px-4 py-3 dark:border-zinc-800"
                >
                  <div className="flex flex-col gap-0.5">
                    <span className="text-sm font-medium">
                      <span className="font-mono text-xs text-zinc-500">
                        {d.id}
                      </span>{" "}
                      {d.title}
                    </span>
                    <span className="text-xs text-zinc-500">
                      {n} question{n === 1 ? "" : "s"}
                      {note ? ` · ${note}` : ""}
                    </span>
                  </div>
                  {n > 0 ? (
                    <Link
                      href={runHref("domain", d.id)}
                      className="rounded-full border border-zinc-300 px-3 py-1 text-xs transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
                    >
                      Drill
                    </Link>
                  ) : (
                    <span className="text-xs text-zinc-500">—</span>
                  )}
                </li>
              );
            })}
          </ul>
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">By task statement</h2>
          <p className="text-xs text-zinc-500">
            Only showing task statements that currently have at least one
            question.
          </p>
          <ul className="flex flex-col gap-1">
            {taskStatements
              .map((t) => ({ t, n: tsCount(t.id) }))
              .filter(({ n }) => n > 0)
              .map(({ t, n }) => (
                <li key={t.id}>
                  <Link
                    href={runHref("task", t.id)}
                    className="flex items-baseline gap-3 rounded-md px-3 py-2 text-sm text-zinc-700 transition-colors hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-900"
                  >
                    <span className="font-mono text-xs text-zinc-500">
                      {t.id}
                    </span>
                    <span className="flex-1">{t.title}</span>
                    <span className="text-xs text-zinc-500">{n}</span>
                  </Link>
                </li>
              ))}
          </ul>
        </section>

        {scenarios.length > 0 ? (
          <section className="flex flex-col gap-3">
            <h2 className="text-lg font-semibold">By scenario</h2>
            <ul className="flex flex-col gap-1">
              {scenarios.map((s) => {
                const n = scenarioCount(s.id);
                return (
                  <li key={s.id}>
                    {n > 0 ? (
                      <Link
                        href={runHref("scenario", s.id)}
                        className="flex items-baseline gap-3 rounded-md px-3 py-2 text-sm text-zinc-700 transition-colors hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-900"
                      >
                        <span className="font-mono text-xs text-zinc-500">
                          {s.id}
                        </span>
                        <span className="flex-1">{s.title}</span>
                        <span className="text-xs text-zinc-500">{n}</span>
                      </Link>
                    ) : (
                      <div className="flex items-baseline gap-3 rounded-md px-3 py-2 text-sm text-zinc-400">
                        <span className="font-mono text-xs">{s.id}</span>
                        <span className="flex-1">{s.title}</span>
                        <span className="text-xs">no questions</span>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}
      </div>
    </main>
  );
}
