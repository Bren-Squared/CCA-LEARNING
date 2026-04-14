import { asc, desc, eq } from "drizzle-orm";
import { type Db, getAppDb, schema } from "../db";
import {
  type BloomLevel,
  BLOOM_LEVELS,
  ceilingLevel,
  domainSummary,
  isMastered,
  type LevelScore,
  nextLevel,
  taskStatementSummary,
} from "./mastery";

/**
 * Dashboard aggregation. Reads snapshots (not raw events), composes per-TS
 * and per-domain rollups, and produces a weak-area ranking. All math lives
 * in mastery.ts — this module is the DB-binding layer plus the ranking
 * heuristic.
 *
 * Snapshot.score is stored 0..100 (see progress/events.ts); we divide by 100
 * before passing into the 0..1 math and multiply back out for display.
 */

export interface LevelCell extends LevelScore {
  level: BloomLevel;
  mastered: boolean;
}

export interface TaskStatementRollup {
  taskStatementId: string;
  title: string;
  domainId: string;
  /** OD2-weighted summary, 0..100 */
  summary: number;
  /** Highest mastered Bloom level, or 0 if none */
  ceiling: BloomLevel | 0;
  /** ceiling + 1, capped at 6 — used by "Drill this" launcher */
  nextLevel: BloomLevel;
  levels: LevelCell[];
  /** Total raw events across all Bloom levels — useful for "cold" TS detection */
  totalItems: number;
}

export interface DomainRollup {
  domainId: string;
  title: string;
  weightBps: number;
  /** Unweighted mean of TS summaries in this domain, 0..100 */
  summary: number;
  taskStatements: TaskStatementRollup[];
}

export interface WeakArea {
  taskStatementId: string;
  title: string;
  domainId: string;
  domainWeightBps: number;
  summary: number;
  ceiling: BloomLevel | 0;
  /** gap × domain_weight_bps / 10000 — the ranking score (higher = weaker) */
  priority: number;
}

export interface RecentEvent {
  id: string;
  ts: Date;
  kind: schema.ProgressEvent["kind"];
  taskStatementId: string;
  taskStatementTitle: string;
  bloomLevel: BloomLevel;
  success: boolean;
}

export interface LastSessionRecap {
  /** Same calendar day as the most recent event, in local time */
  date: Date | null;
  totalEvents: number;
  successCount: number;
  /** Unique (taskStatementId, bloomLevel) touched in the session */
  uniqueCells: number;
  events: RecentEvent[];
}

export interface DashboardData {
  domains: DomainRollup[];
  weakAreas: WeakArea[];
  lastSession: LastSessionRecap;
  totals: {
    activeTaskStatements: number;
    masteredCells: number;
    totalCells: number;
    /** Overall mastery: mean of domain summaries, 0..100 */
    overallSummary: number;
  };
}

export const WEAK_AREA_LIMIT = 5;
const SESSION_RECAP_LIMIT = 20;

/**
 * Compute the full dashboard payload in one DB round-trip batch. Every
 * aggregation is derived from `mastery_snapshots`; `progress_events` is
 * only queried for the last-session recap.
 */
export function buildDashboard(db: Db = getAppDb()): DashboardData {
  const domains = db
    .select()
    .from(schema.domains)
    .orderBy(asc(schema.domains.orderIndex))
    .all();

  const taskStatements = db
    .select()
    .from(schema.taskStatements)
    .orderBy(asc(schema.taskStatements.orderIndex))
    .all();

  const snapshots = db.select().from(schema.masterySnapshots).all();

  // Group snapshots by TS for O(1) lookup
  const snapsByTs = new Map<string, schema.MasterySnapshot[]>();
  for (const s of snapshots) {
    const bucket = snapsByTs.get(s.taskStatementId) ?? [];
    bucket.push(s);
    snapsByTs.set(s.taskStatementId, bucket);
  }

  let masteredCells = 0;
  let totalCells = 0;

  const tsRollups: TaskStatementRollup[] = taskStatements.map((ts) => {
    const snaps = snapsByTs.get(ts.id) ?? [];
    const perLevel: Partial<Record<BloomLevel, LevelScore>> = {};
    const levels: LevelCell[] = BLOOM_LEVELS.map((level) => {
      const snap = snaps.find((s) => s.bloomLevel === level);
      const ls: LevelScore = {
        score: snap ? snap.score / 100 : 0,
        itemCount: snap?.itemCount ?? 0,
      };
      perLevel[level] = ls;
      const mastered = isMastered(ls);
      totalCells += 1;
      if (mastered) masteredCells += 1;
      return { level, ...ls, mastered };
    });

    const levelScoresForSummary: Partial<Record<BloomLevel, number>> = {};
    for (const lvl of BLOOM_LEVELS) {
      levelScoresForSummary[lvl] = perLevel[lvl]?.score ?? 0;
    }

    return {
      taskStatementId: ts.id,
      title: ts.title,
      domainId: ts.domainId,
      summary: taskStatementSummary(levelScoresForSummary),
      ceiling: ceilingLevel(perLevel),
      nextLevel: nextLevel(perLevel),
      levels,
      totalItems: levels.reduce((a, l) => a + l.itemCount, 0),
    };
  });

  const rollupsByDomain = new Map<string, TaskStatementRollup[]>();
  for (const r of tsRollups) {
    const bucket = rollupsByDomain.get(r.domainId) ?? [];
    bucket.push(r);
    rollupsByDomain.set(r.domainId, bucket);
  }

  const domainRollups: DomainRollup[] = domains.map((d) => {
    const tss = rollupsByDomain.get(d.id) ?? [];
    return {
      domainId: d.id,
      title: d.title,
      weightBps: d.weightBps,
      summary: domainSummary(tss.map((t) => t.summary)),
      taskStatements: tss,
    };
  });

  const domainWeightById = new Map(domains.map((d) => [d.id, d.weightBps]));
  const weakAreas: WeakArea[] = tsRollups
    .map((r) => {
      const weightBps = domainWeightById.get(r.domainId) ?? 0;
      // gap * weight_bps, normalized by 10_000 (bps → ratio) so priority
      // reads as a percentage-point-weighted gap.
      const priority = (100 - r.summary) * (weightBps / 10000);
      return {
        taskStatementId: r.taskStatementId,
        title: r.title,
        domainId: r.domainId,
        domainWeightBps: weightBps,
        summary: r.summary,
        ceiling: r.ceiling,
        priority,
      };
    })
    .sort((a, b) => b.priority - a.priority)
    .slice(0, WEAK_AREA_LIMIT);

  const lastSession = buildLastSessionRecap(db, taskStatements);

  const overallSummary =
    domainRollups.length > 0
      ? domainRollups.reduce((a, d) => a + d.summary, 0) / domainRollups.length
      : 0;

  return {
    domains: domainRollups,
    weakAreas,
    lastSession,
    totals: {
      activeTaskStatements: taskStatements.length,
      masteredCells,
      totalCells,
      overallSummary,
    },
  };
}

/**
 * Focused rollup for one task statement — computes the same per-level
 * LevelCell array + summary + ceiling that `buildDashboard` does, but with
 * a single snapshots query scoped to the TS. Returns null if the TS doesn't
 * exist. Used by the TS detail page's Bloom ladder.
 */
export function buildTaskStatementRollup(
  taskStatementId: string,
  db: Db = getAppDb(),
): TaskStatementRollup | null {
  const ts = db
    .select()
    .from(schema.taskStatements)
    .where(eq(schema.taskStatements.id, taskStatementId))
    .get();
  if (!ts) return null;

  const snaps = db
    .select()
    .from(schema.masterySnapshots)
    .where(eq(schema.masterySnapshots.taskStatementId, taskStatementId))
    .all();

  const perLevel: Partial<Record<BloomLevel, LevelScore>> = {};
  const levels: LevelCell[] = BLOOM_LEVELS.map((level) => {
    const snap = snaps.find((s) => s.bloomLevel === level);
    const ls: LevelScore = {
      score: snap ? snap.score / 100 : 0,
      itemCount: snap?.itemCount ?? 0,
    };
    perLevel[level] = ls;
    return { level, ...ls, mastered: isMastered(ls) };
  });

  const levelScoresForSummary: Partial<Record<BloomLevel, number>> = {};
  for (const lvl of BLOOM_LEVELS) {
    levelScoresForSummary[lvl] = perLevel[lvl]?.score ?? 0;
  }

  return {
    taskStatementId: ts.id,
    title: ts.title,
    domainId: ts.domainId,
    summary: taskStatementSummary(levelScoresForSummary),
    ceiling: ceilingLevel(perLevel),
    nextLevel: nextLevel(perLevel),
    levels,
    totalItems: levels.reduce((a, l) => a + l.itemCount, 0),
  };
}

function buildLastSessionRecap(
  db: Db,
  taskStatements: schema.TaskStatement[],
): LastSessionRecap {
  const rows = db
    .select()
    .from(schema.progressEvents)
    .orderBy(desc(schema.progressEvents.ts))
    .limit(SESSION_RECAP_LIMIT)
    .all();
  if (rows.length === 0) {
    return {
      date: null,
      totalEvents: 0,
      successCount: 0,
      uniqueCells: 0,
      events: [],
    };
  }

  const titleById = new Map(taskStatements.map((t) => [t.id, t.title]));
  const cellKeys = new Set<string>();
  let successCount = 0;
  const events: RecentEvent[] = rows.map((r) => {
    cellKeys.add(`${r.taskStatementId}|${r.bloomLevel}`);
    if (r.success) successCount += 1;
    return {
      id: r.id,
      ts: r.ts,
      kind: r.kind,
      taskStatementId: r.taskStatementId,
      taskStatementTitle: titleById.get(r.taskStatementId) ?? r.taskStatementId,
      bloomLevel: r.bloomLevel as BloomLevel,
      success: r.success,
    };
  });

  return {
    date: rows[0].ts,
    totalEvents: rows.length,
    successCount,
    uniqueCells: cellKeys.size,
    events,
  };
}
