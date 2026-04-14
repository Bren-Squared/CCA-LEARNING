import { asc } from "drizzle-orm";
import { type Db, getAppDb, schema } from "../db";
import { readSettings } from "../settings";
import {
  type BloomLevel,
  BLOOM_LEVELS,
  computeLevelScore,
  computeReadiness,
  DEFAULT_HALF_LIFE_DAYS,
  domainSummary,
  type ScoredEvent,
  taskStatementSummary,
} from "./mastery";

/**
 * Improvement-over-time series. For each of the last N days (local midnight
 * boundary), we recompute each (task_statement × Bloom level) score from the
 * full event log up to that moment, roll up to TS → domain → weighted
 * readiness, and stash one point per day.
 *
 * The event-log replay is pure — no writes, no DB mutations. `mastery_snapshots`
 * is used nowhere here; the snapshots table caches the latest state, but the
 * trend chart needs historical as-of state which only the event log preserves.
 *
 * Cost budget: 30 days × ~30 TSs × 6 levels = 5400 computeLevelScore calls per
 * render. Events are pulled once into memory. At single-user scale this is well
 * under 10 ms in practice.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export interface TrendPoint {
  /** "YYYY-MM-DD" (local date of the as-of instant) */
  date: string;
  /** Milliseconds since epoch — end-of-day local time */
  timestamp: number;
  /** domainId → summary (0..100) */
  domains: Record<string, number>;
  /** OD2-weighted overall readiness (0..100) */
  readiness: number;
}

export interface TrendDomainMeta {
  id: string;
  title: string;
  weightBps: number;
}

export interface TrendSeries {
  days: number;
  points: TrendPoint[];
  domains: TrendDomainMeta[];
}

export interface BuildTrendOpts {
  days?: number;
  now?: Date;
  halfLifeDays?: number;
}

/**
 * Snap to end-of-day local time. Using end-of-day (23:59:59.999) means
 * events written "today" show up in today's point rather than pushing into
 * tomorrow — matches user expectation that a finished drill shows up on the
 * chart the same day.
 */
function endOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

function formatDate(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function buildTrendSeries(
  db: Db = getAppDb(),
  opts: BuildTrendOpts = {},
): TrendSeries {
  const days = opts.days ?? 30;
  const nowMs = (opts.now ?? new Date()).getTime();
  const halfLifeDays =
    opts.halfLifeDays ??
    (() => {
      try {
        return readSettings(db).reviewHalfLifeDays;
      } catch {
        return DEFAULT_HALF_LIFE_DAYS;
      }
    })();

  const domains = db
    .select()
    .from(schema.domains)
    .orderBy(asc(schema.domains.orderIndex))
    .all();
  const domainMeta: TrendDomainMeta[] = domains.map((d) => ({
    id: d.id,
    title: d.title,
    weightBps: d.weightBps,
  }));

  const taskStatements = db.select().from(schema.taskStatements).all();
  const tssByDomain = new Map<string, typeof taskStatements>();
  for (const t of taskStatements) {
    const bucket = tssByDomain.get(t.domainId) ?? [];
    bucket.push(t);
    tssByDomain.set(t.domainId, bucket);
  }

  const eventRows = db
    .select({
      taskStatementId: schema.progressEvents.taskStatementId,
      bloomLevel: schema.progressEvents.bloomLevel,
      ts: schema.progressEvents.ts,
      success: schema.progressEvents.success,
    })
    .from(schema.progressEvents)
    .orderBy(asc(schema.progressEvents.ts))
    .all();

  // Pre-bucket events by (tsId|level) so the per-day replay only scans the
  // relevant cell instead of the whole log.
  const eventsByCell = new Map<string, ScoredEvent[]>();
  for (const e of eventRows) {
    const key = `${e.taskStatementId}|${e.bloomLevel}`;
    const bucket = eventsByCell.get(key) ?? [];
    bucket.push({ success: e.success, ts: e.ts.getTime() });
    eventsByCell.set(key, bucket);
  }

  const points: TrendPoint[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const asOf = endOfDay(nowMs - i * DAY_MS);

    const domainSummaries: Record<string, number> = {};
    const readinessInputs: Array<{ summary: number; weightBps: number }> = [];

    for (const d of domainMeta) {
      const tss = tssByDomain.get(d.id) ?? [];
      const tsSummaries: number[] = [];
      for (const ts of tss) {
        const levelScores: Partial<Record<BloomLevel, number>> = {};
        for (const level of BLOOM_LEVELS) {
          const cellEvents = eventsByCell.get(`${ts.id}|${level}`) ?? [];
          // Only events ≤ as-of contribute; the bucket is ts-sorted ascending
          // so we can early-terminate as soon as we hit a future event.
          const filtered: ScoredEvent[] = [];
          for (const ev of cellEvents) {
            if (ev.ts > asOf) break;
            filtered.push(ev);
          }
          levelScores[level] = computeLevelScore(filtered, {
            now: asOf,
            halfLifeDays,
          }).score;
        }
        tsSummaries.push(taskStatementSummary(levelScores));
      }
      const summary = domainSummary(tsSummaries);
      domainSummaries[d.id] = summary;
      readinessInputs.push({ summary, weightBps: d.weightBps });
    }

    points.push({
      date: formatDate(asOf),
      timestamp: asOf,
      domains: domainSummaries,
      readiness: computeReadiness(readinessInputs),
    });
  }

  return { days, points, domains: domainMeta };
}
