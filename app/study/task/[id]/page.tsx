import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { getAppDb, schema } from "@/lib/db";
import { hasApiKey } from "@/lib/settings";
import { readExplainerCache } from "@/lib/study/explainer";
import StudyTaskDetail from "./StudyTaskDetail";

export const dynamic = "force-dynamic";

export default async function TaskStatementPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const db = getAppDb();

  const ts = db
    .select()
    .from(schema.taskStatements)
    .where(eq(schema.taskStatements.id, id))
    .get();
  if (!ts) notFound();

  const domain = db
    .select()
    .from(schema.domains)
    .where(eq(schema.domains.id, ts.domainId))
    .get();

  const cached = readExplainerCache(id, db);
  const keyConfigured = hasApiKey(db);

  return (
    <main className="flex flex-1 flex-col items-center px-6 py-12">
      <div className="flex w-full max-w-3xl flex-col gap-8">
        <header className="flex flex-col gap-2">
          <p className="text-xs font-mono uppercase tracking-widest text-zinc-500">
            {domain ? `${domain.id} · ${domain.title}` : ts.domainId}
          </p>
          <h1 className="text-3xl font-semibold tracking-tight">{ts.title}</h1>
          <p className="text-xs font-mono text-zinc-500">{ts.id}</p>
        </header>

        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">Knowledge</h2>
          <ul className="flex flex-col gap-2 text-sm text-zinc-700 dark:text-zinc-300">
            {ts.knowledgeBullets.map((b, i) => (
              <li key={i} className="flex gap-2">
                <span className="text-zinc-400">•</span>
                <span>{b}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">Skills</h2>
          <ul className="flex flex-col gap-2 text-sm text-zinc-700 dark:text-zinc-300">
            {ts.skillsBullets.map((b, i) => (
              <li key={i} className="flex gap-2">
                <span className="text-zinc-400">•</span>
                <span>{b}</span>
              </li>
            ))}
          </ul>
        </section>

        <StudyTaskDetail
          taskStatementId={ts.id}
          initialArtifact={cached}
          apiKeyConfigured={keyConfigured}
        />
      </div>
    </main>
  );
}
