import { asc } from "drizzle-orm";
import { getAppDb, schema } from "@/lib/db";
import { hasApiKey, readSettings } from "@/lib/settings";
import {
  buildCoverageReport,
  COVERAGE_BLOOM_LEVELS,
  COVERAGE_TARGET,
  type CoverageBloomLevel,
} from "@/lib/study/coverage";
import { listBulkJobs } from "@/lib/study/bulk-gen";
import BulkSection from "./BulkSection";
import CoverageFillForm from "./CoverageFillForm";
import DedupSection from "./DedupSection";

export const dynamic = "force-dynamic";

function cellClass(count: number): string {
  if (count >= COVERAGE_TARGET) {
    return "bg-green-100 text-green-900 dark:bg-green-950/40 dark:text-green-200";
  }
  if (count === 0) {
    return "bg-red-50 text-red-900 dark:bg-red-950/40 dark:text-red-200";
  }
  return "bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200";
}

export default async function CoveragePage() {
  const db = getAppDb();
  const keyConfigured = hasApiKey(db);
  const settings = readSettings(db);
  const report = buildCoverageReport(db);
  const bulkJobs = listBulkJobs(db);

  const domains = db
    .select()
    .from(schema.domains)
    .orderBy(asc(schema.domains.orderIndex))
    .all();

  const cellByKey = new Map<string, number>();
  for (const cell of report.cells) {
    cellByKey.set(
      `${cell.taskStatementId}|${cell.bloomLevel}`,
      cell.activeCount,
    );
  }

  const taskStatements = db
    .select()
    .from(schema.taskStatements)
    .orderBy(asc(schema.taskStatements.orderIndex))
    .all();

  const tsByDomain = new Map<string, typeof taskStatements>();
  for (const ts of taskStatements) {
    const bucket = tsByDomain.get(ts.domainId) ?? [];
    bucket.push(ts);
    tsByDomain.set(ts.domainId, bucket);
  }

  return (
    <main className="flex flex-1 flex-col items-center px-6 py-12">
      <div className="flex w-full max-w-5xl flex-col gap-8">
        <header className="flex flex-col gap-2">
          <p className="text-xs font-mono uppercase tracking-widest text-zinc-500">
            Admin
          </p>
          <h1 className="text-3xl font-semibold tracking-tight">Coverage</h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Target: {COVERAGE_TARGET} active questions per (task statement ×
            Bloom level 1–5). Green = full, amber = partial, red = empty. Retired
            and flagged questions don&apos;t count.
          </p>
        </header>

        <section className="flex flex-wrap gap-4 rounded-xl border border-zinc-200 px-5 py-4 text-sm dark:border-zinc-800">
          <Stat label="Active questions" value={report.totals.activeQuestions} />
          <Stat
            label="Cells filled"
            value={`${report.totals.fullCells} / ${report.totals.totalCells}`}
          />
          <Stat label="Gap cells" value={report.totals.gapCells} />
          <Stat
            label="Gap questions"
            value={report.totals.gapQuestions}
            accent={report.totals.gapQuestions > 0 ? "amber" : "green"}
          />
          <Stat
            label="Bullet blind spots"
            value={report.totals.bulletBlindSpotCount}
            accent={report.totals.bulletBlindSpotCount > 0 ? "amber" : "green"}
          />
          <Stat
            label="Missing citations"
            value={report.totals.questionsMissingBulletCitations}
            accent={
              report.totals.questionsMissingBulletCitations > 0 ? "amber" : "green"
            }
          />
        </section>

        <CoverageFillForm
          gapQuestions={report.totals.gapQuestions}
          apiKeyConfigured={keyConfigured}
        />

        <BulkSection
          gapQuestions={report.totals.gapQuestions}
          apiKeyConfigured={keyConfigured}
          jobs={bulkJobs}
          ceilingUsd={settings.bulkCostCeilingUsd}
        />

        <DedupSection apiKeyConfigured={keyConfigured} />

        <BulletBlindSpotsSection report={report} />

        <section className="flex flex-col gap-6">
          {domains.map((d) => {
            const tss = tsByDomain.get(d.id) ?? [];
            if (tss.length === 0) return null;
            return (
              <div key={d.id} className="flex flex-col gap-3">
                <h2 className="text-sm font-mono uppercase tracking-widest text-zinc-500">
                  {d.id} · {d.title}
                </h2>
                <div className="overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
                  <table className="w-full text-sm">
                    <thead className="bg-zinc-50 dark:bg-zinc-900">
                      <tr>
                        <th className="px-3 py-2 text-left font-medium text-zinc-600 dark:text-zinc-400">
                          Task statement
                        </th>
                        {COVERAGE_BLOOM_LEVELS.map((lvl) => (
                          <th
                            key={lvl}
                            className="px-3 py-2 text-right font-mono text-xs text-zinc-500"
                          >
                            L{lvl}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {tss.map((ts) => (
                        <tr
                          key={ts.id}
                          className="border-t border-zinc-200 dark:border-zinc-800"
                        >
                          <td className="px-3 py-2">
                            <span className="font-mono text-xs text-zinc-500">
                              {ts.id}
                            </span>{" "}
                            <span className="text-zinc-700 dark:text-zinc-300">
                              {ts.title}
                            </span>
                          </td>
                          {COVERAGE_BLOOM_LEVELS.map((lvl) => {
                            const count =
                              cellByKey.get(`${ts.id}|${lvl}`) ?? 0;
                            return (
                              <td
                                key={lvl}
                                className={`px-3 py-2 text-right font-mono text-xs ${cellClass(count)}`}
                              >
                                {count} / {COVERAGE_TARGET}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })}
        </section>

      </div>
    </main>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string | number;
  accent?: "amber" | "green";
}) {
  const color =
    accent === "amber"
      ? "text-amber-700 dark:text-amber-400"
      : accent === "green"
        ? "text-green-700 dark:text-green-400"
        : "text-zinc-800 dark:text-zinc-200";
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-zinc-500">{label}</span>
      <span className={`text-lg font-semibold ${color}`}>{value}</span>
    </div>
  );
}

function BulletBlindSpotsSection({
  report,
}: {
  report: ReturnType<typeof buildCoverageReport>;
}) {
  const blind = report.bulletBlindSpots;
  const grouped = new Map<
    string,
    { tsId: string; tsTitle: string; rows: typeof blind }
  >();
  for (const row of blind) {
    const key = row.taskStatementId;
    const prev = grouped.get(key) ?? {
      tsId: row.taskStatementId,
      tsTitle: row.taskStatementTitle,
      rows: [],
    };
    prev.rows.push(row);
    grouped.set(key, prev);
  }
  return (
    <section className="flex flex-col gap-4 rounded-xl border border-zinc-200 p-5 dark:border-zinc-800">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-mono uppercase tracking-widest text-zinc-500">
          Bullet blind spots · E3 / AT22
        </h2>
        <span className="font-mono text-xs text-zinc-500">
          {blind.length} of {report.bulletCoverage.length} bullets uncovered
          {report.totals.questionsMissingBulletCitations > 0 ? (
            <>
              {" "}
              · {report.totals.questionsMissingBulletCitations} questions need
              backfill
            </>
          ) : null}
        </span>
      </div>
      {report.totals.questionsMissingBulletCitations > 0 ? (
        <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
          {report.totals.questionsMissingBulletCitations} active question
          {report.totals.questionsMissingBulletCitations === 1 ? "" : "s"} have
          no bullet citations yet (legacy data from before E3). Run{" "}
          <code className="font-mono">
            npx tsx scripts/backfill-bullet-coverage.ts
          </code>{" "}
          to classify them with the cheap model. Until then, blind-spot counts
          may overstate the true gap.
        </p>
      ) : null}
      {blind.length === 0 ? (
        <p className="text-sm text-zinc-500">
          Every bullet has at least one active question citing it. ✓
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          {Array.from(grouped.values()).map((group) => (
            <div key={group.tsId} className="flex flex-col gap-2">
              <h3 className="text-xs font-mono uppercase tracking-wider text-zinc-500">
                {group.tsId} · {group.tsTitle}
              </h3>
              <ul className="flex flex-col gap-1">
                {group.rows.map((row) => (
                  <li
                    key={`${row.taskStatementId}|${row.kind}|${row.bulletIdx}`}
                    className="flex items-baseline gap-2 rounded-md border border-zinc-200 px-3 py-2 text-xs dark:border-zinc-800"
                  >
                    <span className="rounded-full bg-zinc-200 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                      {row.kind} [{row.bulletIdx}]
                    </span>
                    <span className="text-zinc-700 dark:text-zinc-300">
                      {row.bulletText}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// narrow import path to avoid tree-shake surprises — referenced only for typing
export type { CoverageBloomLevel };
