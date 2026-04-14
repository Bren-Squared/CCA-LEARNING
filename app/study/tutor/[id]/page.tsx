import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { getAppDb, schema } from "@/lib/db";
import {
  getTutorSession,
  TutorSessionError,
} from "@/lib/tutor/sessions";
import { getSettingsStatus } from "@/lib/settings";
import TutorChat from "./TutorChat";

export const dynamic = "force-dynamic";

export default async function TutorSessionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const db = getAppDb();
  const status = getSettingsStatus(db);

  let session;
  try {
    session = getTutorSession(id, db);
  } catch (err) {
    if (err instanceof TutorSessionError && err.code === "not_found") {
      notFound();
    }
    throw err;
  }

  const ts = db
    .select({
      id: schema.taskStatements.id,
      title: schema.taskStatements.title,
      domainId: schema.taskStatements.domainId,
    })
    .from(schema.taskStatements)
    .where(eq(schema.taskStatements.id, session.topicId))
    .get();

  return (
    <main className="flex flex-1 flex-col items-center px-6 py-10">
      <div className="flex w-full max-w-3xl flex-col gap-6">
        <header className="flex flex-col gap-2">
          <Link
            href="/study/tutor"
            className="text-xs text-zinc-500 underline-offset-2 hover:underline"
          >
            ← All sessions
          </Link>
          <div className="flex flex-wrap items-baseline gap-3">
            <span className="font-mono text-xs uppercase tracking-widest text-zinc-500">
              {session.topicId}
            </span>
            <h1 className="text-2xl font-semibold tracking-tight">
              {ts?.title ?? "Tutor session"}
            </h1>
          </div>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Case facts (Bloom ceiling, recent misses) are rebuilt on every
            turn. The loop only advances on{" "}
            <code className="rounded bg-zinc-100 px-1 font-mono text-xs dark:bg-zinc-900">
              stop_reason=tool_use
            </code>{" "}
            — never on assistant text.
          </p>
        </header>

        {!status.apiKeyConfigured ? (
          <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
            No API key configured.{" "}
            <Link href="/settings" className="underline">
              Open settings
            </Link>{" "}
            to add one before sending a turn.
          </p>
        ) : null}

        <TutorChat
          sessionId={session.id}
          topicId={session.topicId}
          initialMessages={session.messages}
        />
      </div>
    </main>
  );
}
