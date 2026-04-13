import { eq } from "drizzle-orm";
import Link from "next/link";
import { getAppDb, schema } from "@/lib/db";
import { buildDrillPool, type DrillScope } from "@/lib/study/drill";
import DrillSession from "./DrillSession";

export const dynamic = "force-dynamic";

function parseScope(params: URLSearchParams): DrillScope {
  const type = params.get("scope") ?? "all";
  const id = params.get("id") ?? "";
  if (type === "domain" && id) return { type: "domain", id };
  if (type === "task" && id) return { type: "task", id };
  if (type === "scenario" && id) return { type: "scenario", id };
  return { type: "all" };
}

function scopeLabel(scope: DrillScope, db: ReturnType<typeof getAppDb>): string {
  if (scope.type === "all") return "Mixed drill · all active questions";
  if (scope.type === "domain") {
    const row = db
      .select()
      .from(schema.domains)
      .where(eq(schema.domains.id, scope.id))
      .get();
    return row ? `Domain · ${row.id} ${row.title}` : `Domain · ${scope.id}`;
  }
  if (scope.type === "task") {
    const row = db
      .select()
      .from(schema.taskStatements)
      .where(eq(schema.taskStatements.id, scope.id))
      .get();
    return row ? `Task · ${row.id} ${row.title}` : `Task · ${scope.id}`;
  }
  const row = db
    .select()
    .from(schema.scenarios)
    .where(eq(schema.scenarios.id, scope.id))
    .get();
  return row ? `Scenario · ${row.id} ${row.title}` : `Scenario · ${scope.id}`;
}

export default async function DrillRunPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (typeof v === "string") params.set(k, v);
  }

  const scope = parseScope(params);
  const db = getAppDb();
  const label = scopeLabel(scope, db);
  const pool = buildDrillPool(scope, { db });

  if (pool.questions.length === 0) {
    return (
      <main className="flex flex-1 flex-col items-center px-6 py-12">
        <div className="flex w-full max-w-2xl flex-col gap-6">
          <header className="flex flex-col gap-2">
            <p className="text-xs font-mono uppercase tracking-widest text-zinc-500">
              Drill
            </p>
            <h1 className="text-2xl font-semibold">Nothing to drill yet</h1>
          </header>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            {label} has no active questions. Phase 6 fills in the bank by
            generating questions per task statement.
          </p>
          <Link
            href="/drill"
            className="self-start rounded-full border border-zinc-300 px-4 py-2 text-sm transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
          >
            Back to launcher
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="flex flex-1 flex-col items-center px-6 py-12">
      <div className="flex w-full max-w-3xl flex-col gap-6">
        <header className="flex flex-col gap-2">
          <p className="text-xs font-mono uppercase tracking-widest text-zinc-500">
            Drill
          </p>
          <h1 className="text-xl font-semibold">{label}</h1>
          <p className="text-xs text-zinc-500">
            {pool.questions.length} of {pool.availableCount} available,
            shuffled.
          </p>
        </header>
        <DrillSession questions={pool.questions} scopeLabel={label} />
      </div>
    </main>
  );
}
