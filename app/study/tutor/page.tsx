import Link from "next/link";
import { getAppDb, schema } from "@/lib/db";
import { listTutorSessions } from "@/lib/tutor/sessions";
import NewSessionForm from "./NewSessionForm";

export const dynamic = "force-dynamic";

export default async function TutorIndexPage() {
  const db = getAppDb();
  const sessions = listTutorSessions(db, { limit: 50 });

  const tsRows = db
    .select({
      id: schema.taskStatements.id,
      title: schema.taskStatements.title,
      domainId: schema.taskStatements.domainId,
    })
    .from(schema.taskStatements)
    .orderBy(schema.taskStatements.orderIndex)
    .all();

  return (
    <main className="flex flex-1 flex-col items-center px-6 py-12">
      <div className="flex w-full max-w-3xl flex-col gap-8">
        <header className="flex flex-col gap-2">
          <p className="text-xs font-mono uppercase tracking-widest text-zinc-500">
            Socratic tutor
          </p>
          <h1 className="text-3xl font-semibold tracking-tight">
            Resume a session or start a new one
          </h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            One thread per task statement. The tutor rebuilds your case facts
            every turn (Bloom ceiling, recent misses, verbatim bullets) and
            drives entirely via tool calls — no text-content heuristics (D1.1).
          </p>
        </header>

        <section className="flex flex-col gap-4 rounded-xl border border-zinc-200 p-5 dark:border-zinc-800">
          <h2 className="text-sm font-mono uppercase tracking-widest text-zinc-500">
            Start a new session
          </h2>
          <NewSessionForm taskStatements={tsRows} />
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-mono uppercase tracking-widest text-zinc-500">
            Active sessions ({sessions.length})
          </h2>
          {sessions.length === 0 ? (
            <p className="text-sm text-zinc-500">No sessions yet.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-zinc-200 dark:divide-zinc-800">
              {sessions.map((s) => (
                <li key={s.id}>
                  <Link
                    href={`/study/tutor/${encodeURIComponent(s.id)}`}
                    className="flex flex-wrap items-baseline justify-between gap-3 px-1 py-2 text-sm transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-900"
                  >
                    <span className="font-mono text-xs text-zinc-500">
                      {s.topicId}
                    </span>
                    <span className="flex-1 truncate text-zinc-700 dark:text-zinc-300">
                      {s.messageCount} msg
                    </span>
                    <span className="font-mono text-xs text-zinc-500">
                      {new Date(s.updatedAt).toLocaleString()}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
