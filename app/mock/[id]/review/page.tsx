import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { eq, inArray } from "drizzle-orm";
import { getAppDb, schema } from "@/lib/db";
import {
  MOCK_PASS_SCALED,
  MOCK_SCALED_MAX,
  MOCK_SCALED_MIN,
  MockAttemptError,
  getMockAttempt,
} from "@/lib/mock/attempts";
import MockReview, { type ReviewQuestion } from "./MockReview";

export const dynamic = "force-dynamic";

export default async function MockReviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const db = getAppDb();
  let attempt;
  try {
    attempt = getMockAttempt(id, { db });
  } catch (err) {
    if (err instanceof MockAttemptError && err.code === "not_found") notFound();
    throw err;
  }
  if (attempt.status === "in_progress") {
    redirect(`/mock/${id}`);
  }

  const rows = db
    .select({
      id: schema.questions.id,
      stem: schema.questions.stem,
      options: schema.questions.options,
      correctIndex: schema.questions.correctIndex,
      explanations: schema.questions.explanations,
      taskStatementId: schema.questions.taskStatementId,
      bloomLevel: schema.questions.bloomLevel,
      tsTitle: schema.taskStatements.title,
      domainId: schema.taskStatements.domainId,
    })
    .from(schema.questions)
    .innerJoin(
      schema.taskStatements,
      eq(schema.taskStatements.id, schema.questions.taskStatementId),
    )
    .where(inArray(schema.questions.id, attempt.questionIds))
    .all();

  const byId = new Map(rows.map((r) => [r.id, r]));
  const questions: ReviewQuestion[] = attempt.questionIds.map((qid, idx) => {
    const r = byId.get(qid);
    const answer = attempt.answers[idx];
    if (!r) {
      return {
        index: idx,
        id: qid,
        stem: "(question unavailable)",
        options: [],
        correctIndex: -1,
        explanations: [],
        taskStatementId: "",
        taskStatementTitle: "",
        domainId: "",
        bloomLevel: 0,
        selectedIndex: answer,
        correct: false,
      };
    }
    return {
      index: idx,
      id: r.id,
      stem: r.stem,
      options: r.options,
      correctIndex: r.correctIndex,
      explanations: r.explanations,
      taskStatementId: r.taskStatementId,
      taskStatementTitle: r.tsTitle,
      domainId: r.domainId,
      bloomLevel: r.bloomLevel,
      selectedIndex: answer,
      correct: answer !== null && answer === r.correctIndex,
    };
  });

  const passBandColor =
    attempt.scaledScore === null
      ? "bg-zinc-200 dark:bg-zinc-800"
      : attempt.passed
        ? "bg-green-100 dark:bg-green-950/40"
        : "bg-red-100 dark:bg-red-950/40";
  const passTextColor =
    attempt.scaledScore === null
      ? "text-zinc-700 dark:text-zinc-300"
      : attempt.passed
        ? "text-green-800 dark:text-green-300"
        : "text-red-800 dark:text-red-300";

  return (
    <main className="mx-auto max-w-4xl px-6 py-8 font-sans text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <header className="mb-6 flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">
          Mock exam review
        </h1>
        <Link
          href="/mock"
          className="text-sm text-zinc-600 underline dark:text-zinc-400"
        >
          ← All attempts
        </Link>
      </header>

      <section
        className={`mb-4 rounded-xl border border-zinc-200 p-6 dark:border-zinc-800 ${passBandColor}`}
      >
        <div className="flex flex-wrap items-baseline justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-wider text-zinc-600 dark:text-zinc-400">
              Scaled score (RD2 approximation)
            </p>
            <p className={`text-5xl font-bold tabular-nums ${passTextColor}`}>
              {attempt.scaledScore ?? "—"}
            </p>
            <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
              Range {MOCK_SCALED_MIN}–{MOCK_SCALED_MAX} · Pass at{" "}
              {MOCK_PASS_SCALED}
            </p>
          </div>
          <div className="text-right">
            <p className={`text-2xl font-semibold ${passTextColor}`}>
              {attempt.passed === null
                ? "—"
                : attempt.passed
                  ? "PASS"
                  : "FAIL"}
            </p>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
              {attempt.rawScore ?? 0}/60 raw ·{" "}
              {attempt.status === "timeout" ? "timed out" : "submitted"}
            </p>
          </div>
        </div>
        <p className="mt-4 text-xs text-zinc-600 dark:text-zinc-400">
          Anthropic does not publish the exam&apos;s raw-to-scaled formula. Scores
          here use a piecewise-linear mapping anchored at 72% raw = 720 scaled
          and are a practice approximation only.
        </p>
      </section>

      <MockReview questions={questions} />
    </main>
  );
}
