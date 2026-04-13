import { asc } from "drizzle-orm";
import Link from "next/link";
import { getAppDb, schema } from "@/lib/db";
import { getSettingsStatus } from "@/lib/settings";

export const dynamic = "force-dynamic";

export default async function Home() {
  const db = getAppDb();
  const status = getSettingsStatus(db);
  const domains = status.apiKeyConfigured
    ? db.select().from(schema.domains).orderBy(asc(schema.domains.orderIndex)).all()
    : [];
  const taskStatements = status.apiKeyConfigured
    ? db
        .select()
        .from(schema.taskStatements)
        .orderBy(asc(schema.taskStatements.orderIndex))
        .all()
    : [];
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
      {status.apiKeyConfigured ? (
        <div className="flex w-full max-w-3xl flex-col gap-6">
          <div className="flex items-center justify-between rounded-xl border border-zinc-200 px-4 py-3 text-sm dark:border-zinc-800">
            <span className="text-green-700 dark:text-green-400">
              API key ({status.apiKeyRedacted}) · {status.defaultModel}
            </span>
            <Link
              href="/settings"
              className="text-zinc-600 underline hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
            >
              Settings
            </Link>
          </div>
          {domains.map((d) => (
            <section key={d.id} className="flex flex-col gap-2">
              <h2 className="text-xs font-mono uppercase tracking-widest text-zinc-500">
                {d.id} · {d.title}
              </h2>
              <ul className="flex flex-col gap-1">
                {taskStatements
                  .filter((t) => t.domainId === d.id)
                  .map((t) => (
                    <li key={t.id}>
                      <Link
                        href={`/study/task/${t.id}`}
                        className="flex items-baseline gap-3 rounded-md px-3 py-2 text-sm text-zinc-700 transition-colors hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-900"
                      >
                        <span className="font-mono text-xs text-zinc-500">
                          {t.id}
                        </span>
                        <span>{t.title}</span>
                      </Link>
                    </li>
                  ))}
              </ul>
            </section>
          ))}
        </div>
      ) : (
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
      )}
    </main>
  );
}

