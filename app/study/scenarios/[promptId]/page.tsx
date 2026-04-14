import Link from "next/link";
import { notFound } from "next/navigation";
import { getAppDb } from "@/lib/db";
import { getScenarioPrompt, readRubricCache } from "@/lib/scenarios/prompts";
import { listAttemptsForPrompt } from "@/lib/scenarios/grade";
import { getSettingsStatus } from "@/lib/settings";
import ScenarioGrader from "./ScenarioGrader";

export const dynamic = "force-dynamic";

export default async function ScenarioPromptPage({
  params,
}: {
  params: Promise<{ promptId: string }>;
}) {
  const { promptId } = await params;
  const db = getAppDb();

  const prompt = getScenarioPrompt(promptId, db);
  if (!prompt) notFound();

  const status = getSettingsStatus(db);
  const rubric = readRubricCache(promptId, db);
  const attempts = listAttemptsForPrompt(promptId, db).slice(0, 5);

  return (
    <main className="flex flex-1 flex-col items-center px-6 py-10">
      <div className="flex w-full max-w-3xl flex-col gap-6">
        <header className="flex flex-col gap-2">
          <Link
            href="/study/scenarios"
            className="text-xs text-zinc-500 underline-offset-2 hover:underline"
          >
            ← All scenarios
          </Link>
          <div className="flex flex-wrap items-baseline gap-3">
            <span className="font-mono text-xs uppercase tracking-widest text-zinc-500">
              {prompt.scenarioId} · {prompt.taskStatementId} · Bloom L
              {prompt.bloomLevel}
            </span>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {prompt.scenarioTitle}
          </h1>
          <p className="text-xs text-zinc-500">
            Target: {prompt.taskStatementTitle}
          </p>
        </header>

        <section className="flex flex-col gap-2 rounded-xl border border-zinc-200 bg-zinc-50 p-5 dark:border-zinc-800 dark:bg-zinc-950/40">
          <p className="text-[10px] font-mono uppercase tracking-wider text-zinc-400">
            Prompt
          </p>
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-zinc-800 dark:text-zinc-200">
            {prompt.promptText}
          </p>
        </section>

        {!status.apiKeyConfigured ? (
          <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
            No API key configured.{" "}
            <Link href="/settings" className="underline">
              Open settings
            </Link>{" "}
            to add one before grading.
          </p>
        ) : null}

        <ScenarioGrader
          promptId={prompt.id}
          rubricReady={rubric !== null}
        />

        {rubric ? (
          <details className="rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
            <summary className="cursor-pointer text-sm font-medium">
              Rubric · {rubric.rubric.criteria.length} criteria
            </summary>
            <ul className="mt-3 flex flex-col gap-3">
              {rubric.rubric.criteria.map((c) => (
                <li
                  key={c.id}
                  className="flex flex-col gap-1 rounded-md bg-zinc-50 p-3 text-xs dark:bg-zinc-950/40"
                >
                  <div className="flex items-baseline justify-between">
                    <span className="font-mono text-[10px] uppercase tracking-wider text-zinc-500">
                      {c.id}
                    </span>
                    <span className="font-mono text-[10px] text-zinc-500">
                      weight {c.weight.toFixed(2)}
                    </span>
                  </div>
                  <p className="text-sm font-medium">{c.title}</p>
                  <p className="text-zinc-600 dark:text-zinc-400">
                    {c.description}
                  </p>
                </li>
              ))}
            </ul>
          </details>
        ) : null}

        {attempts.length > 0 ? (
          <section className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold">Recent attempts</h2>
            <ul className="flex flex-col divide-y divide-zinc-200 dark:divide-zinc-800">
              {attempts.map((a) => (
                <li
                  key={a.id}
                  className="flex items-baseline justify-between py-2 text-xs text-zinc-500"
                >
                  <span className="font-mono">
                    {a.createdAt.toISOString().slice(0, 16).replace("T", " ")}
                  </span>
                  <span
                    className={
                      a.overallScore >= 4
                        ? "font-mono font-semibold text-emerald-700 dark:text-emerald-400"
                        : a.overallScore >= 3
                          ? "font-mono font-semibold text-amber-700 dark:text-amber-400"
                          : "font-mono font-semibold text-red-700 dark:text-red-400"
                    }
                  >
                    {a.overallScore.toFixed(1)} / 5
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </main>
  );
}
