import Link from "next/link";
import { notFound } from "next/navigation";
import { getAppDb } from "@/lib/db";
import { getExercise, readStepRubricCache } from "@/lib/exercises/steps";
import { listAttemptsForStep } from "@/lib/exercises/grade";
import { getSettingsStatus } from "@/lib/settings";
import ExerciseStepGrader from "./ExerciseStepGrader";

export const dynamic = "force-dynamic";

export default async function ExerciseDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const db = getAppDb();

  const exercise = getExercise(id, db);
  if (!exercise) notFound();

  const status = getSettingsStatus(db);

  const stepData = exercise.steps.map((step) => {
    const rubric = readStepRubricCache(step.id, db);
    const attempts = listAttemptsForStep(step.id, db);
    const latest = attempts[0] ?? null;
    const bestGrade = attempts.reduce<number | null>((best, a) => {
      if (a.grade === null) return best;
      return best === null || a.grade > best ? a.grade : best;
    }, null);
    return { step, rubric, latest, bestGrade, attemptCount: attempts.length };
  });

  const passedCount = stepData.filter(
    (s) => s.bestGrade !== null && s.bestGrade >= 3.0,
  ).length;

  return (
    <main className="flex flex-1 flex-col items-center px-6 py-10">
      <div className="flex w-full max-w-3xl flex-col gap-8">
        <header className="flex flex-col gap-2">
          <Link
            href="/study/exercises"
            className="text-xs text-zinc-500 underline-offset-2 hover:underline"
          >
            ← All exercises
          </Link>
          <div className="flex flex-wrap items-baseline gap-3">
            <span className="font-mono text-xs uppercase tracking-widest text-zinc-500">
              {exercise.id}
            </span>
            <span className="font-mono text-xs uppercase tracking-widest text-zinc-500">
              reinforces {exercise.domainsReinforced.join(", ")}
            </span>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {exercise.title}
          </h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            {exercise.description}
          </p>
          <p className="text-xs text-zinc-500">
            {passedCount}/{exercise.stepCount} step
            {exercise.stepCount === 1 ? "" : "s"} passed (≥ 3.0 / 5).
          </p>
        </header>

        {!status.apiKeyConfigured ? (
          <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
            No API key configured.{" "}
            <Link href="/settings" className="underline">
              Open settings
            </Link>{" "}
            to add one before submitting artifacts.
          </p>
        ) : null}

        <ol className="flex flex-col gap-6">
          {stepData.map(
            ({ step, rubric, latest, bestGrade, attemptCount }) => (
              <li
                key={step.id}
                className="flex flex-col gap-4 rounded-xl border border-zinc-200 p-5 dark:border-zinc-800"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div className="flex items-baseline gap-2">
                    <span className="font-mono text-xs uppercase tracking-widest text-zinc-500">
                      Step {step.stepIdx + 1} of {exercise.stepCount}
                    </span>
                    <span
                      className={
                        rubric
                          ? "font-mono text-[10px] uppercase tracking-wider text-emerald-700 dark:text-emerald-400"
                          : "font-mono text-[10px] uppercase tracking-wider text-zinc-500"
                      }
                    >
                      {rubric
                        ? `rubric warmed · ${rubric.rubric.criteria.length} criteria`
                        : "rubric on first submit"}
                    </span>
                  </div>
                  {bestGrade !== null ? (
                    <span
                      className={
                        bestGrade >= 4
                          ? "font-mono text-sm font-semibold text-emerald-700 dark:text-emerald-400"
                          : bestGrade >= 3
                            ? "font-mono text-sm font-semibold text-amber-700 dark:text-amber-400"
                            : "font-mono text-sm font-semibold text-red-700 dark:text-red-400"
                      }
                    >
                      best {bestGrade.toFixed(1)} / 5 · {attemptCount} attempt
                      {attemptCount === 1 ? "" : "s"}
                    </span>
                  ) : null}
                </div>

                <p className="whitespace-pre-wrap rounded-md bg-zinc-50 p-3 text-sm leading-relaxed text-zinc-800 dark:bg-zinc-950/40 dark:text-zinc-200">
                  {step.prompt}
                </p>

                {rubric ? (
                  <details className="rounded-md border border-zinc-200 p-3 text-xs dark:border-zinc-800">
                    <summary className="cursor-pointer font-mono uppercase tracking-wider text-zinc-500">
                      Rubric · {rubric.rubric.criteria.length} criteria
                    </summary>
                    <ul className="mt-2 flex flex-col gap-2">
                      {rubric.rubric.criteria.map((c) => (
                        <li
                          key={c.id}
                          className="flex flex-col gap-0.5 rounded-md bg-zinc-50 p-2 dark:bg-zinc-950/40"
                        >
                          <div className="flex items-baseline justify-between">
                            <span className="font-mono text-[10px] uppercase tracking-wider text-zinc-500">
                              {c.id}
                            </span>
                            <span className="font-mono text-[10px] text-zinc-500">
                              weight {c.weight.toFixed(2)}
                            </span>
                          </div>
                          <p className="text-xs font-medium">{c.title}</p>
                          <p className="text-xs text-zinc-600 dark:text-zinc-400">
                            {c.description}
                          </p>
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}

                <ExerciseStepGrader
                  stepId={step.id}
                  stepIdx={step.stepIdx}
                  stepTotal={exercise.stepCount}
                  rubricReady={rubric !== null}
                  latestAttempt={
                    latest
                      ? {
                          grade: latest.grade,
                          strengths: latest.strengths,
                          gaps: latest.gaps,
                          modelAnswer: latest.modelAnswer,
                          perCriterion: latest.perCriterion,
                          createdAt: latest.createdAt.toISOString(),
                        }
                      : null
                  }
                />
              </li>
            ),
          )}
        </ol>
      </div>
    </main>
  );
}
