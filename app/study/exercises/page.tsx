import Link from "next/link";
import { getAppDb, schema } from "@/lib/db";
import { listExercises } from "@/lib/exercises/steps";

export const dynamic = "force-dynamic";

export default async function ExercisesIndexPage() {
  const db = getAppDb();
  const exercises = listExercises(db);
  const steps = db.select().from(schema.preparationSteps).all();
  const attempts = db.select().from(schema.preparationAttempts).all();

  const stepRubricMap = new Map(
    steps.map((s) => [
      s.id,
      s.rubric !== null && s.rubricGeneratedAt !== null,
    ]),
  );

  const bestByStep = new Map<string, number>();
  for (const a of attempts) {
    if (a.grade === null) continue;
    const prev = bestByStep.get(a.stepId);
    if (prev === undefined || a.grade > prev) bestByStep.set(a.stepId, a.grade);
  }

  return (
    <main className="flex flex-1 flex-col items-center px-6 py-10">
      <div className="flex w-full max-w-4xl flex-col gap-8">
        <header className="flex flex-col gap-2">
          <p className="text-xs font-mono uppercase tracking-widest text-zinc-500">
            Preparation exercises · FR2.7
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">
            {exercises.length} exercise{exercises.length === 1 ? "" : "s"} · build
            artifacts, earn Bloom-6 (Create) events
          </h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Each step is graded in an isolated Claude context against a
            lazily-authored rubric. A passing grade writes one Create-level
            progress event per task statement the exercise reinforces — these
            are the highest-leverage mastery events in the app.
          </p>
        </header>

        {exercises.length === 0 ? (
          <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
            No exercises seeded yet. Run{" "}
            <code className="font-mono">npm run ingest</code>.
          </p>
        ) : (
          <ul className="flex flex-col gap-4">
            {exercises.map((ex) => {
              const exStepIds = steps
                .filter((s) => s.exerciseId === ex.id)
                .sort((a, b) => a.stepIdx - b.stepIdx)
                .map((s) => s.id);
              const passedSteps = exStepIds.filter(
                (sid) => (bestByStep.get(sid) ?? 0) >= 3.0,
              ).length;
              const rubricsWarm = exStepIds.filter(
                (sid) => stepRubricMap.get(sid) === true,
              ).length;
              return (
                <li key={ex.id}>
                  <Link
                    href={`/study/exercises/${encodeURIComponent(ex.id)}`}
                    className="flex flex-col gap-3 rounded-xl border border-zinc-200 p-5 transition-colors hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900/40"
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-3">
                      <div className="flex items-baseline gap-2">
                        <span className="font-mono text-xs uppercase tracking-widest text-zinc-500">
                          {ex.id}
                        </span>
                        <h2 className="text-lg font-semibold">{ex.title}</h2>
                      </div>
                      <div className="flex items-baseline gap-3 font-mono text-xs text-zinc-500">
                        <span>
                          reinforces {ex.domainsReinforced.join(", ")}
                        </span>
                      </div>
                    </div>
                    <p className="text-sm text-zinc-600 dark:text-zinc-400">
                      {ex.description}
                    </p>
                    <div className="flex flex-wrap items-center gap-4 text-xs">
                      <div className="flex items-center gap-1.5">
                        {exStepIds.map((sid) => {
                          const best = bestByStep.get(sid);
                          const color =
                            best === undefined
                              ? "bg-zinc-300 dark:bg-zinc-700"
                              : best >= 4
                                ? "bg-emerald-500"
                                : best >= 3
                                  ? "bg-amber-500"
                                  : "bg-red-500";
                          return (
                            <span
                              key={sid}
                              aria-label={
                                best === undefined
                                  ? "not attempted"
                                  : `best ${best.toFixed(1)}/5`
                              }
                              title={
                                best === undefined
                                  ? "not attempted"
                                  : `best ${best.toFixed(1)}/5`
                              }
                              className={`h-2.5 w-2.5 rounded-full ${color}`}
                            />
                          );
                        })}
                      </div>
                      <span className="font-mono text-zinc-500">
                        {passedSteps}/{ex.stepCount} passed · {rubricsWarm}/
                        {ex.stepCount} rubrics warmed
                      </span>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </main>
  );
}
