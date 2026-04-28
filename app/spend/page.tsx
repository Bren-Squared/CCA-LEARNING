import Link from "next/link";
import { getAppDb } from "@/lib/db";
import {
  CACHE_HIT_MIN_SAMPLE,
  CACHE_HIT_WARN_THRESHOLD,
  SOFT_WARN_RATIO,
  computeSpendSummary,
  type CacheStatsEntry,
} from "@/lib/spend/summary";

export const dynamic = "force-dynamic";

function usd(n: number): string {
  return `$${n.toFixed(n >= 10 ? 2 : 4)}`;
}

function kTokens(n: number): string {
  if (n < 1000) return `${n}`;
  return `${(n / 1000).toFixed(1)}k`;
}

function barColor(ratio: number): string {
  if (ratio >= 1) return "bg-red-500";
  if (ratio >= SOFT_WARN_RATIO) return "bg-amber-500";
  return "bg-emerald-500";
}

function durationLabel(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return `${m}m ${rs}s`;
}

export default async function SpendPage() {
  const db = getAppDb();
  const summary = computeSpendSummary(db);
  const ratioPct = Math.min(100, summary.budgetUsedRatio * 100);

  return (
    <main className="flex flex-1 flex-col items-center px-6 py-10">
      <div className="flex w-full max-w-4xl flex-col gap-8">
        <header className="flex flex-col gap-2">
          <p className="text-xs font-mono uppercase tracking-widest text-zinc-500">
            Claude API spend · FR5.4 · NFR4.2
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">
            {usd(summary.monthToDate.costUsd)} this month · budget{" "}
            {usd(summary.budgetMonthUsd)}
          </h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Estimates derived from per-call token usage logged in{" "}
            <code className="font-mono">claude_call_log</code>. Pricing is
            the rate card as of the last deployment; amounts are indicative
            and do not replace your Anthropic console invoice.
          </p>
        </header>

        <section className="flex flex-col gap-2 rounded-xl border border-zinc-200 p-5 dark:border-zinc-800">
          <div className="flex items-baseline justify-between text-sm">
            <span className="text-zinc-600 dark:text-zinc-400">
              Month-to-date spend
            </span>
            <span className="font-mono font-semibold">
              {usd(summary.monthToDate.costUsd)} /{" "}
              {usd(summary.budgetMonthUsd)} ·{" "}
              {(summary.budgetUsedRatio * 100).toFixed(1)}%
            </span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
            <div
              className={`h-full rounded-full transition-[width] duration-500 ${barColor(summary.budgetUsedRatio)}`}
              style={{ width: `${ratioPct}%` }}
            />
          </div>
          {summary.softWarning ? (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              NFR4.2 soft warning — you are at or past{" "}
              {(SOFT_WARN_RATIO * 100).toFixed(0)}% of the monthly budget.
              Raise it in{" "}
              <Link href="/settings" className="underline">
                Settings
              </Link>{" "}
              or throttle Claude-backed features until next month.
            </p>
          ) : (
            <p className="text-xs text-zinc-500">
              {usd(summary.budgetMonthUsd - summary.monthToDate.costUsd)} of
              headroom remaining.
            </p>
          )}
        </section>

        <section className="grid gap-5 md:grid-cols-2">
          <div className="flex flex-col gap-2 rounded-xl border border-zinc-200 p-5 dark:border-zinc-800">
            <h2 className="text-sm font-mono uppercase tracking-widest text-zinc-500">
              Current session
            </h2>
            {summary.currentSession.callCount === 0 ? (
              <p className="text-sm text-zinc-500">
                No calls yet. A session starts when you trigger a Claude-backed
                feature; it ends after 30 minutes of idle.
              </p>
            ) : (
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                <dt className="text-zinc-500">Cost</dt>
                <dd className="text-right font-mono font-semibold">
                  {usd(summary.currentSession.costUsd)}
                </dd>
                <dt className="text-zinc-500">Calls</dt>
                <dd className="text-right font-mono">
                  {summary.currentSession.callCount}
                </dd>
                <dt className="text-zinc-500">Input / output</dt>
                <dd className="text-right font-mono">
                  {kTokens(summary.currentSession.inputTokens)} /{" "}
                  {kTokens(summary.currentSession.outputTokens)}
                </dd>
                <dt className="text-zinc-500">Cache (write/read)</dt>
                <dd className="text-right font-mono">
                  {kTokens(summary.currentSession.cacheCreationTokens)} /{" "}
                  {kTokens(summary.currentSession.cacheReadTokens)}
                </dd>
                <dt className="text-zinc-500">Started</dt>
                <dd className="text-right font-mono text-xs">
                  {summary.currentSession.startedAt
                    ?.toISOString()
                    .slice(0, 16)
                    .replace("T", " ") ?? "—"}
                </dd>
              </dl>
            )}
          </div>

          <div className="flex flex-col gap-2 rounded-xl border border-zinc-200 p-5 dark:border-zinc-800">
            <h2 className="text-sm font-mono uppercase tracking-widest text-zinc-500">
              Month totals
            </h2>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
              <dt className="text-zinc-500">Calls</dt>
              <dd className="text-right font-mono">
                {summary.monthToDate.callCount}
              </dd>
              <dt className="text-zinc-500">Input / output tokens</dt>
              <dd className="text-right font-mono">
                {kTokens(summary.monthToDate.inputTokens)} /{" "}
                {kTokens(summary.monthToDate.outputTokens)}
              </dd>
              <dt className="text-zinc-500">Cache (write/read)</dt>
              <dd className="text-right font-mono">
                {kTokens(summary.monthToDate.cacheCreationTokens)} /{" "}
                {kTokens(summary.monthToDate.cacheReadTokens)}
              </dd>
              <dt className="text-zinc-500">Avg cost / call</dt>
              <dd className="text-right font-mono">
                {summary.monthToDate.callCount > 0
                  ? usd(
                      summary.monthToDate.costUsd /
                        summary.monthToDate.callCount,
                    )
                  : "—"}
              </dd>
            </dl>
          </div>
        </section>

        <section className="flex flex-col gap-4">
          <h2 className="text-sm font-mono uppercase tracking-widest text-zinc-500">
            By role · month-to-date
          </h2>
          {summary.monthToDate.byRole.length === 0 ? (
            <p className="text-sm text-zinc-500">Nothing logged yet.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-zinc-200 dark:divide-zinc-800">
              {summary.monthToDate.byRole.map((e) => (
                <li
                  key={e.key}
                  className="flex items-baseline justify-between py-2 text-sm"
                >
                  <div className="flex items-baseline gap-2">
                    <span className="font-mono">{e.key}</span>
                    <span className="text-xs text-zinc-500">
                      · {e.callCount} call{e.callCount === 1 ? "" : "s"}
                    </span>
                  </div>
                  <span className="font-mono text-xs text-zinc-600 dark:text-zinc-400">
                    {kTokens(e.inputTokens)} in ·{" "}
                    {kTokens(e.outputTokens)} out ·{" "}
                    <span className="font-semibold">{usd(e.costUsd)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <CacheEfficiencyPanel cacheStats={summary.cacheStats} />

        <section className="flex flex-col gap-4">
          <h2 className="text-sm font-mono uppercase tracking-widest text-zinc-500">
            By model · month-to-date
          </h2>
          {summary.monthToDate.byModel.length === 0 ? (
            <p className="text-sm text-zinc-500">Nothing logged yet.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-zinc-200 dark:divide-zinc-800">
              {summary.monthToDate.byModel.map((e) => (
                <li
                  key={e.key}
                  className="flex items-baseline justify-between py-2 text-sm"
                >
                  <div className="flex items-baseline gap-2">
                    <span className="font-mono">{e.key}</span>
                    <span className="text-xs text-zinc-500">
                      · {e.callCount} call{e.callCount === 1 ? "" : "s"}
                    </span>
                  </div>
                  <span className="font-mono text-xs text-zinc-600 dark:text-zinc-400">
                    {kTokens(e.inputTokens)} in ·{" "}
                    {kTokens(e.outputTokens)} out ·{" "}
                    <span className="font-semibold">{usd(e.costUsd)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="flex flex-col gap-4">
          <h2 className="text-sm font-mono uppercase tracking-widest text-zinc-500">
            Recent calls
          </h2>
          {summary.recentCalls.length === 0 ? (
            <p className="text-sm text-zinc-500">Nothing logged yet.</p>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
              <table className="w-full border-collapse text-xs">
                <thead className="bg-zinc-50 text-left font-mono uppercase tracking-wider text-[10px] text-zinc-500 dark:bg-zinc-950/60">
                  <tr>
                    <th className="px-3 py-2">Timestamp</th>
                    <th className="px-3 py-2">Role</th>
                    <th className="px-3 py-2">Model</th>
                    <th className="px-3 py-2 text-right">In</th>
                    <th className="px-3 py-2 text-right">Out</th>
                    <th className="px-3 py-2 text-right">Stop</th>
                    <th className="px-3 py-2 text-right">Duration</th>
                    <th className="px-3 py-2 text-right">Cost</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
                  {summary.recentCalls.map((c) => (
                    <tr key={c.id}>
                      <td className="px-3 py-2 font-mono">
                        {c.ts.toISOString().slice(0, 19).replace("T", " ")}
                      </td>
                      <td className="px-3 py-2 font-mono">{c.role}</td>
                      <td className="px-3 py-2 font-mono">{c.model}</td>
                      <td className="px-3 py-2 text-right font-mono">
                        {kTokens(c.inputTokens)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono">
                        {kTokens(c.outputTokens)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono">
                        {c.stopReason ?? "—"}
                      </td>
                      <td className="px-3 py-2 text-right font-mono">
                        {durationLabel(c.durationMs)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono font-semibold">
                        {usd(c.costUsd)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

function hitRateColor(hitRate: number): string {
  if (hitRate >= 0.7) return "bg-emerald-500";
  if (hitRate >= 0.3) return "bg-amber-500";
  return "bg-red-500";
}

function CacheEfficiencyPanel({ cacheStats }: { cacheStats: CacheStatsEntry[] }) {
  const cacheable = cacheStats.filter((e) => e.expectsCache);
  const noCache = cacheStats.filter((e) => !e.expectsCache);
  const totalSavedCostUsd = cacheable.reduce((s, e) => s + e.savedCostUsd, 0);

  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-mono uppercase tracking-widest text-zinc-500">
          Cache efficiency · NFR4.3 · E1
        </h2>
        {cacheable.length > 0 ? (
          <span className="font-mono text-xs text-zinc-500">
            {usd(totalSavedCostUsd)} saved this month
          </span>
        ) : null}
      </div>
      {cacheStats.length === 0 ? (
        <p className="text-sm text-zinc-500">
          Nothing logged yet. Run a tutor turn or generate a question to see
          cache metrics.
        </p>
      ) : (
        <div className="flex flex-col gap-5">
          {cacheable.length > 0 ? (
            <div className="flex flex-col gap-2">
              <p className="font-mono text-[10px] uppercase tracking-wider text-zinc-500">
                Cache-enabled roles
              </p>
              <ul className="flex flex-col divide-y divide-zinc-200 dark:divide-zinc-800">
                {cacheable.map((e) => (
                  <CacheRow key={e.role} entry={e} />
                ))}
              </ul>
            </div>
          ) : null}
          {noCache.length > 0 ? (
            <div className="flex flex-col gap-2">
              <p className="font-mono text-[10px] uppercase tracking-wider text-zinc-500">
                No-cache (by design)
              </p>
              <ul className="flex flex-col divide-y divide-zinc-200 dark:divide-zinc-800">
                {noCache.map((e) => (
                  <li
                    key={e.role}
                    className="flex items-baseline justify-between py-2 text-sm"
                  >
                    <div className="flex items-baseline gap-2">
                      <span className="font-mono">{e.role}</span>
                      <span className="text-xs text-zinc-500">
                        · {e.callCount} call{e.callCount === 1 ? "" : "s"}
                      </span>
                    </div>
                    <span className="text-xs text-zinc-500">no-cache</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <p className="text-xs text-zinc-500">
            Hit rate = cache_read / (cache_read + cache_creation) per role.
            Amber pill triggers when a cache-enabled role is below{" "}
            {(CACHE_HIT_WARN_THRESHOLD * 100).toFixed(0)}% over at least{" "}
            {CACHE_HIT_MIN_SAMPLE} calls — investigate the system prompt for
            inadvertent per-call variation.
          </p>
        </div>
      )}
    </section>
  );
}

function CacheRow({ entry }: { entry: CacheStatsEntry }) {
  const hitPct = entry.hitRate * 100;
  return (
    <li className="flex flex-col gap-2 py-3 text-sm">
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <span className="font-mono">{entry.role}</span>
          <span className="text-xs text-zinc-500">
            · {entry.callCount} call{entry.callCount === 1 ? "" : "s"}
          </span>
          {entry.warn ? (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
              low hit rate
            </span>
          ) : null}
        </div>
        <span className="font-mono text-xs text-zinc-600 dark:text-zinc-400">
          {hitPct.toFixed(1)}% · {usd(entry.savedCostUsd)} saved
        </span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
        <div
          className={`h-full rounded-full transition-[width] duration-500 ${hitRateColor(entry.hitRate)}`}
          style={{ width: `${Math.min(100, hitPct)}%` }}
        />
      </div>
      <div className="flex items-baseline justify-between font-mono text-[11px] text-zinc-500">
        <span>
          {kTokens(entry.cacheReadTokens)} read · {kTokens(entry.cacheCreationTokens)} created
        </span>
        <span>{kTokens(entry.savedInputTokenEquivalents)} tokens saved</span>
      </div>
    </li>
  );
}
