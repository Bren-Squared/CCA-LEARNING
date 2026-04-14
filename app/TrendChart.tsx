import type { TrendSeries } from "@/lib/progress/trend";

/**
 * Improvement-over-time chart (AT9). Inline SVG — no chart library. Renders
 * one polyline per domain plus a bold overall-readiness line. All points are
 * recomputed from the event log on every request, so this is always in sync
 * with the latest state.
 */

const WIDTH = 800;
const HEIGHT = 220;
const PAD_LEFT = 40;
const PAD_RIGHT = 16;
const PAD_TOP = 12;
const PAD_BOTTOM = 28;
const PLOT_W = WIDTH - PAD_LEFT - PAD_RIGHT;
const PLOT_H = HEIGHT - PAD_TOP - PAD_BOTTOM;

const DOMAIN_COLORS = [
  "#6366f1", // indigo
  "#f59e0b", // amber
  "#10b981", // emerald
  "#ef4444", // rose
  "#8b5cf6", // violet
  "#06b6d4", // cyan
];
const OVERALL_COLOR = "#0f172a"; // slate-900
const GRID_COLOR = "#e4e4e7"; // zinc-200

function xAt(i: number, total: number): number {
  if (total <= 1) return PAD_LEFT + PLOT_W / 2;
  return PAD_LEFT + (i / (total - 1)) * PLOT_W;
}

function yAt(value: number): number {
  const clamped = Math.max(0, Math.min(100, value));
  return PAD_TOP + (1 - clamped / 100) * PLOT_H;
}

function pointsAttr(values: number[]): string {
  return values.map((v, i) => `${xAt(i, values.length)},${yAt(v)}`).join(" ");
}

export default function TrendChart({
  series,
  readiness,
}: {
  series: TrendSeries;
  readiness: number;
}) {
  const { points, domains } = series;
  const overallValues = points.map((p) => p.readiness);
  const domainValues = domains.map((d) => points.map((p) => p.domains[d.id] ?? 0));

  const firstDate = points[0]?.date ?? "";
  const lastDate = points[points.length - 1]?.date ?? "";

  return (
    <section className="flex flex-col gap-4 rounded-xl border border-zinc-200 p-5 dark:border-zinc-800">
      <header className="flex flex-wrap items-baseline justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-sm font-mono uppercase tracking-widest text-zinc-500">
            Improvement over {series.days} days (AT9)
          </h2>
          <p className="text-xs text-zinc-500">
            Recomputed from the event log at end-of-day boundaries. Mock exam
            scaled scores will overlay here once Phase 10 lands.
          </p>
        </div>
        <ReadinessBadge value={readiness} />
      </header>

      <div className="w-full overflow-x-auto">
        <svg
          role="img"
          aria-label={`Per-domain mastery and readiness over ${series.days} days`}
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          className="h-56 w-full min-w-[480px]"
          preserveAspectRatio="none"
        >
          <title>Mastery trend over {series.days} days</title>
          {/* Gridlines */}
          {[0, 25, 50, 75, 100].map((v) => (
            <g key={v}>
              <line
                x1={PAD_LEFT}
                x2={PAD_LEFT + PLOT_W}
                y1={yAt(v)}
                y2={yAt(v)}
                stroke={GRID_COLOR}
                strokeWidth={1}
                strokeDasharray={v === 0 || v === 100 ? undefined : "2 3"}
              />
              <text
                x={PAD_LEFT - 6}
                y={yAt(v)}
                fontSize={10}
                fill="#71717a"
                textAnchor="end"
                dominantBaseline="central"
              >
                {v}
              </text>
            </g>
          ))}

          {/* Domain lines — thin, muted */}
          {domains.map((d, i) => (
            <polyline
              key={d.id}
              fill="none"
              stroke={DOMAIN_COLORS[i % DOMAIN_COLORS.length]}
              strokeWidth={1.5}
              strokeOpacity={0.65}
              strokeLinecap="round"
              strokeLinejoin="round"
              points={pointsAttr(domainValues[i])}
            />
          ))}

          {/* Overall readiness — bold, on top */}
          <polyline
            fill="none"
            stroke={OVERALL_COLOR}
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            points={pointsAttr(overallValues)}
          />

          {/* X-axis endpoints */}
          <text
            x={PAD_LEFT}
            y={HEIGHT - 8}
            fontSize={10}
            fill="#71717a"
            textAnchor="start"
          >
            {firstDate}
          </text>
          <text
            x={PAD_LEFT + PLOT_W}
            y={HEIGHT - 8}
            fontSize={10}
            fill="#71717a"
            textAnchor="end"
          >
            {lastDate}
          </text>
        </svg>
      </div>

      <ul className="flex flex-wrap gap-x-5 gap-y-2 text-xs">
        <li className="flex items-center gap-2 font-medium">
          <span
            aria-hidden
            className="inline-block h-0.5 w-5"
            style={{ backgroundColor: OVERALL_COLOR }}
          />
          <span>Overall readiness</span>
          <span className="font-mono text-zinc-500">
            {readiness.toFixed(0)}%
          </span>
        </li>
        {domains.map((d, i) => (
          <li
            key={d.id}
            className="flex items-center gap-2 text-zinc-600 dark:text-zinc-400"
          >
            <span
              aria-hidden
              className="inline-block h-0.5 w-5"
              style={{
                backgroundColor: DOMAIN_COLORS[i % DOMAIN_COLORS.length],
              }}
            />
            <span className="font-mono text-[10px] text-zinc-500">{d.id}</span>
            <span className="truncate">{d.title}</span>
            <span className="font-mono text-zinc-500">
              {(
                points[points.length - 1]?.domains[d.id] ?? 0
              ).toFixed(0)}
              %
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ReadinessBadge({ value }: { value: number }) {
  const tier =
    value >= 80
      ? "bg-green-100 text-green-800 dark:bg-green-950/40 dark:text-green-300"
      : value >= 60
        ? "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
        : "bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-300";
  return (
    <div className="flex flex-col items-end gap-1">
      <span
        className={`rounded-full px-3 py-1 font-mono text-sm font-semibold ${tier}`}
        title="readiness = Σ(domain_summary × domain_weight_bps) / Σ(domain_weight_bps)"
      >
        Readiness {value.toFixed(0)}%
      </span>
      <span className="font-mono text-[10px] text-zinc-500">
        weighted by domain weight_bps
      </span>
    </div>
  );
}
