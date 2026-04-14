import { notFound, redirect } from "next/navigation";
import { eq, inArray } from "drizzle-orm";
import { getAppDb, schema } from "@/lib/db";
import { MockAttemptError, getMockAttempt } from "@/lib/mock/attempts";
import MockExamRunner, { type ExamQuestion } from "./MockExamRunner";

export const dynamic = "force-dynamic";

export default async function MockAttemptPage({
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

  if (attempt.status !== "in_progress") {
    redirect(`/mock/${id}/review`);
  }

  const rows = db
    .select({
      id: schema.questions.id,
      stem: schema.questions.stem,
      options: schema.questions.options,
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
  const questions: ExamQuestion[] = attempt.questionIds.map((qid, idx) => {
    const r = byId.get(qid);
    if (!r) {
      return {
        index: idx,
        id: qid,
        stem: "(question unavailable)",
        options: [],
        taskStatementId: "",
        taskStatementTitle: "",
        domainId: "",
        bloomLevel: 0,
      };
    }
    return {
      index: idx,
      id: r.id,
      stem: r.stem,
      options: r.options,
      taskStatementId: r.taskStatementId,
      taskStatementTitle: r.tsTitle,
      domainId: r.domainId,
      bloomLevel: r.bloomLevel,
    };
  });

  return (
    <main className="mx-auto max-w-4xl px-6 py-6 font-sans text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <MockExamRunner
        attemptId={attempt.id}
        startedAt={attempt.startedAt}
        durationMs={attempt.durationMs}
        initialAnswers={attempt.answers}
        questions={questions}
      />
    </main>
  );
}
