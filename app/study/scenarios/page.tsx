import Link from "next/link";
import { getAppDb } from "@/lib/db";
import { listAllScenariosWithPrompts } from "@/lib/scenarios/prompts";

export const dynamic = "force-dynamic";

export default async function ScenarioIndexPage() {
  const db = getAppDb();
  const scenarios = listAllScenariosWithPrompts(db);

  const promptCount = scenarios.reduce((n, s) => n + s.prompts.length, 0);
  const withRubric = scenarios.reduce(
    (n, s) => n + s.prompts.filter((p) => p.hasRubric).length,
    0,
  );

  return (
    <main className="flex flex-1 flex-col items-center px-6 py-10">
      <div className="flex w-full max-w-4xl flex-col gap-8">
        <header className="flex flex-col gap-2">
          <Link
            href="/"
            className="text-xs text-zinc-500 underline-offset-2 hover:underline"
          >
            ← Dashboard
          </Link>
          <p className="text-xs font-mono uppercase tracking-widest text-zinc-500">
            Scenarios · free-response
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">
            {scenarios.length} scenario{scenarios.length === 1 ? "" : "s"} ·{" "}
            {promptCount} prompt{promptCount === 1 ? "" : "s"}
          </h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Each prompt is graded in an isolated Claude context (AT17) against a
            rubric authored once at prompt-creation time (RD4). Submit an answer
            to receive a 0-5 score, strengths, gaps, and a model answer.{" "}
            <span className="font-mono text-xs">
              {withRubric}/{promptCount} rubrics warmed
            </span>
            .
          </p>
        </header>

        {scenarios.length === 0 ? (
          <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
            No scenarios ingested yet. Run{" "}
            <code className="font-mono">npm run ingest</code>, then{" "}
            <code className="font-mono">npm run seed:scenarios</code>.
          </p>
        ) : (
          <div className="flex flex-col gap-6">
            {scenarios.map((s) => (
              <section
                key={s.scenarioId}
                className="flex flex-col gap-3 rounded-xl border border-zinc-200 p-5 dark:border-zinc-800"
              >
                <div className="flex flex-col gap-1">
                  <div className="flex items-baseline gap-3">
                    <span className="font-mono text-xs uppercase tracking-widest text-zinc-500">
                      {s.scenarioId}
                    </span>
                    <h2 className="text-lg font-semibold">{s.scenarioTitle}</h2>
                  </div>
                  <p className="text-sm text-zinc-600 dark:text-zinc-400">
                    {s.scenarioDescription}
                  </p>
                </div>

                {s.prompts.length === 0 ? (
                  <p className="text-xs text-zinc-500">
                    No prompts seeded for this scenario yet.
                  </p>
                ) : (
                  <ul className="flex flex-col divide-y divide-zinc-200 dark:divide-zinc-800">
                    {s.prompts.map((p) => (
                      <li key={p.id}>
                        <Link
                          href={`/study/scenarios/${p.id}`}
                          className="flex flex-col gap-1 py-3 hover:bg-zinc-50 dark:hover:bg-zinc-900/40"
                        >
                          <div className="flex items-baseline gap-2 text-xs text-zinc-500">
                            <span className="font-mono">
                              {p.taskStatementId}
                            </span>
                            <span>·</span>
                            <span>Bloom L{p.bloomLevel}</span>
                            <span>·</span>
                            <span
                              className={
                                p.hasRubric
                                  ? "text-emerald-700 dark:text-emerald-400"
                                  : "text-zinc-500"
                              }
                            >
                              {p.hasRubric ? "rubric ready" : "rubric on first attempt"}
                            </span>
                          </div>
                          <p className="line-clamp-2 text-sm text-zinc-800 dark:text-zinc-200">
                            {p.promptText}
                          </p>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
