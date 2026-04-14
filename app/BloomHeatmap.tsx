import Link from "next/link";
import type { DomainRollup } from "@/lib/progress/dashboard";
import { BLOOM_LEVELS, type BloomLevel } from "@/lib/progress/mastery";

/**
 * 30×6 heatmap: one row per task statement, one column per Bloom level.
 * Color encodes per-cell mastery (score + item floor). Clicking a cell
 * launches a drill filtered to that (TS, level); cells with no active
 * questions render as inactive to avoid a dead-end drill page.
 */
export default function BloomHeatmap({
  domains,
  cellCounts,
}: {
  domains: DomainRollup[];
  cellCounts: Map<string, number>;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-mono uppercase tracking-widest text-zinc-500">
          Bloom heatmap (AT15)
        </h2>
        <Legend />
      </div>
      <div className="overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
        <table className="w-full border-collapse text-sm">
          <thead className="bg-zinc-50 dark:bg-zinc-900">
            <tr>
              <th className="px-3 py-2 text-left font-medium text-zinc-600 dark:text-zinc-400">
                Task statement
              </th>
              {BLOOM_LEVELS.map((lvl) => (
                <th
                  key={lvl}
                  className="px-2 py-2 text-center font-mono text-xs text-zinc-500"
                >
                  L{lvl}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {domains.map((d) =>
              d.taskStatements.map((t, i) => (
                <tr
                  key={t.taskStatementId}
                  className="border-t border-zinc-200 dark:border-zinc-800"
                >
                  {i === 0 ? (
                    <td
                      className="bg-zinc-50 px-3 py-2 dark:bg-zinc-900"
                      rowSpan={d.taskStatements.length}
                    >
                      <div className="flex flex-col gap-0.5">
                        <span className="font-mono text-[10px] uppercase tracking-wider text-zinc-500">
                          {d.domainId}
                        </span>
                        <span className="text-xs text-zinc-700 dark:text-zinc-300">
                          {d.title}
                        </span>
                      </div>
                    </td>
                  ) : null}
                  <td className="px-3 py-2 align-top">
                    <Link
                      href={`/study/task/${encodeURIComponent(t.taskStatementId)}`}
                      className="flex flex-col gap-0.5 text-xs text-zinc-700 hover:text-indigo-700 dark:text-zinc-300 dark:hover:text-indigo-400"
                    >
                      <span className="font-mono text-[10px] text-zinc-500">
                        {t.taskStatementId}
                      </span>
                      <span className="truncate">{t.title}</span>
                    </Link>
                  </td>
                  {BLOOM_LEVELS.map((lvl) => (
                    <HeatmapCell
                      key={lvl}
                      taskStatementId={t.taskStatementId}
                      level={lvl}
                      score={t.levels.find((x) => x.level === lvl)?.score ?? 0}
                      itemCount={
                        t.levels.find((x) => x.level === lvl)?.itemCount ?? 0
                      }
                      mastered={
                        t.levels.find((x) => x.level === lvl)?.mastered ?? false
                      }
                      activeQuestions={
                        cellCounts.get(`${t.taskStatementId}|${lvl}`) ?? 0
                      }
                    />
                  ))}
                </tr>
              )),
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function cellClass(
  mastered: boolean,
  score: number,
  itemCount: number,
): string {
  if (mastered) {
    return "bg-green-200 text-green-900 dark:bg-green-900/50 dark:text-green-100";
  }
  if (itemCount === 0) {
    return "bg-zinc-100 text-zinc-500 dark:bg-zinc-900/60 dark:text-zinc-500";
  }
  if (score >= 0.6) {
    return "bg-amber-100 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200";
  }
  if (score >= 0.3) {
    return "bg-orange-100 text-orange-900 dark:bg-orange-950/40 dark:text-orange-200";
  }
  return "bg-red-100 text-red-900 dark:bg-red-950/40 dark:text-red-200";
}

function HeatmapCell({
  taskStatementId,
  level,
  score,
  itemCount,
  mastered,
  activeQuestions,
}: {
  taskStatementId: string;
  level: BloomLevel;
  score: number;
  itemCount: number;
  mastered: boolean;
  activeQuestions: number;
}) {
  const className = cellClass(mastered, score, itemCount);
  const label = itemCount === 0 ? "—" : `${Math.round(score * 100)}%`;
  const title = `${taskStatementId} · L${level} · ${label} · n=${itemCount} · ${activeQuestions} active Q${activeQuestions === 1 ? "" : "s"}`;

  const content = (
    <div className="flex flex-col items-center leading-tight">
      <span className="font-mono text-xs">{label}</span>
      <span className="font-mono text-[9px] text-current opacity-70">
        n={itemCount}
      </span>
    </div>
  );

  if (activeQuestions === 0) {
    return (
      <td
        className={`px-1 py-1 text-center ${className} opacity-60`}
        title={`${title} (no questions to drill)`}
      >
        {content}
      </td>
    );
  }

  return (
    <td className={`p-0 text-center ${className}`}>
      <Link
        href={`/drill/run?scope=task&id=${encodeURIComponent(taskStatementId)}&bloom=${level}`}
        title={title}
        className="block px-1 py-1 hover:ring-2 hover:ring-inset hover:ring-indigo-500"
      >
        {content}
      </Link>
    </td>
  );
}

function Legend() {
  return (
    <div className="flex items-center gap-2 text-[10px] font-mono text-zinc-500">
      <span className="flex items-center gap-1">
        <span className="inline-block h-3 w-3 rounded bg-green-200 dark:bg-green-900/50" />
        mastered
      </span>
      <span className="flex items-center gap-1">
        <span className="inline-block h-3 w-3 rounded bg-amber-100 dark:bg-amber-950/40" />
        ≥60
      </span>
      <span className="flex items-center gap-1">
        <span className="inline-block h-3 w-3 rounded bg-orange-100 dark:bg-orange-950/40" />
        ≥30
      </span>
      <span className="flex items-center gap-1">
        <span className="inline-block h-3 w-3 rounded bg-red-100 dark:bg-red-950/40" />
        &lt;30
      </span>
      <span className="flex items-center gap-1">
        <span className="inline-block h-3 w-3 rounded bg-zinc-100 dark:bg-zinc-900/60" />
        no data
      </span>
    </div>
  );
}
