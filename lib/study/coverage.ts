import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../db";
import { getAppDb, schema } from "../db";

/**
 * Target number of active questions per (task_statement × bloom_level) cell
 * for levels 1..5 (FR3.7). Level 6 is not tracked — the exam guide doesn't
 * assess Create at the foundations tier, and generating them adds cost
 * without a learning signal.
 */
export const COVERAGE_TARGET = 5;
export const COVERAGE_BLOOM_LEVELS = [1, 2, 3, 4, 5] as const;
export type CoverageBloomLevel = (typeof COVERAGE_BLOOM_LEVELS)[number];

export interface CoverageCell {
  taskStatementId: string;
  taskStatementTitle: string;
  domainId: string;
  bloomLevel: CoverageBloomLevel;
  activeCount: number;
  gap: number;
}

export type BulletKind = "knowledge" | "skills";

export interface BulletCoverageRow {
  taskStatementId: string;
  taskStatementTitle: string;
  domainId: string;
  kind: BulletKind;
  /** 0-based index into the parent TS's `<kind>Bullets` array. */
  bulletIdx: number;
  bulletText: string;
  questionCount: number;
}

export interface CoverageReport {
  cells: CoverageCell[];
  gaps: CoverageCell[];
  /** Phase 16 / E3 — flat list of bullets with the count of active questions
   *  citing them. Both kinds are interleaved; UI can group by domain → TS. */
  bulletCoverage: BulletCoverageRow[];
  /** Subset of bulletCoverage with `questionCount === 0` — the blind-spot
   *  candidate list rendered on `/admin/coverage`. */
  bulletBlindSpots: BulletCoverageRow[];
  totals: {
    activeQuestions: number;
    gapCells: number;
    gapQuestions: number;
    fullCells: number;
    totalCells: number;
    /** Phase 16 — questions that haven't been backfilled with bullet idxs. */
    questionsMissingBulletCitations: number;
    bulletBlindSpotCount: number;
  };
}

/**
 * Build the (TS × bloom_level 1..5) coverage matrix from the active questions
 * in the bank. `gap` is `max(0, COVERAGE_TARGET - activeCount)` per cell;
 * `gaps` is the subset of cells with `gap > 0`, ordered for rendering
 * (domain → TS → bloom ascending). Pure DB read — no Claude calls.
 *
 * Phase 16 / E3 — also rolls up bullet-level coverage. Each task statement's
 * Knowledge and Skills bullets are listed with the count of active questions
 * citing them. Bullets with zero coverage feed `/admin/coverage`'s blind-spot
 * panel.
 */
export function buildCoverageReport(db: Db = getAppDb()): CoverageReport {
  const taskStatements = db
    .select()
    .from(schema.taskStatements)
    .orderBy(asc(schema.taskStatements.orderIndex))
    .all();

  const activeQuestions = db
    .select({
      taskStatementId: schema.questions.taskStatementId,
      bloomLevel: schema.questions.bloomLevel,
      knowledgeBulletIdxs: schema.questions.knowledgeBulletIdxs,
      skillsBulletIdxs: schema.questions.skillsBulletIdxs,
    })
    .from(schema.questions)
    .where(eq(schema.questions.status, "active"))
    .all();

  const counts = new Map<string, number>();
  // Bullet citation tally: keyed `tsId|kind|idx` → count.
  const bulletCounts = new Map<string, number>();
  let questionsMissingBulletCitations = 0;
  for (const q of activeQuestions) {
    const key = `${q.taskStatementId}|${q.bloomLevel}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    const k = q.knowledgeBulletIdxs ?? [];
    const s = q.skillsBulletIdxs ?? [];
    if (k.length === 0 && s.length === 0) {
      questionsMissingBulletCitations += 1;
    }
    for (const idx of k) {
      const bk = `${q.taskStatementId}|knowledge|${idx}`;
      bulletCounts.set(bk, (bulletCounts.get(bk) ?? 0) + 1);
    }
    for (const idx of s) {
      const bk = `${q.taskStatementId}|skills|${idx}`;
      bulletCounts.set(bk, (bulletCounts.get(bk) ?? 0) + 1);
    }
  }

  const cells: CoverageCell[] = [];
  for (const ts of taskStatements) {
    for (const level of COVERAGE_BLOOM_LEVELS) {
      const count = counts.get(`${ts.id}|${level}`) ?? 0;
      cells.push({
        taskStatementId: ts.id,
        taskStatementTitle: ts.title,
        domainId: ts.domainId,
        bloomLevel: level,
        activeCount: count,
        gap: Math.max(0, COVERAGE_TARGET - count),
      });
    }
  }

  const bulletCoverage: BulletCoverageRow[] = [];
  for (const ts of taskStatements) {
    ts.knowledgeBullets.forEach((text, idx) => {
      bulletCoverage.push({
        taskStatementId: ts.id,
        taskStatementTitle: ts.title,
        domainId: ts.domainId,
        kind: "knowledge",
        bulletIdx: idx,
        bulletText: text,
        questionCount: bulletCounts.get(`${ts.id}|knowledge|${idx}`) ?? 0,
      });
    });
    ts.skillsBullets.forEach((text, idx) => {
      bulletCoverage.push({
        taskStatementId: ts.id,
        taskStatementTitle: ts.title,
        domainId: ts.domainId,
        kind: "skills",
        bulletIdx: idx,
        bulletText: text,
        questionCount: bulletCounts.get(`${ts.id}|skills|${idx}`) ?? 0,
      });
    });
  }

  const bulletBlindSpots = bulletCoverage.filter((b) => b.questionCount === 0);
  const gaps = cells.filter((c) => c.gap > 0);
  const gapQuestions = gaps.reduce((sum, c) => sum + c.gap, 0);

  return {
    cells,
    gaps,
    bulletCoverage,
    bulletBlindSpots,
    totals: {
      activeQuestions: activeQuestions.length,
      gapCells: gaps.length,
      gapQuestions,
      fullCells: cells.length - gaps.length,
      totalCells: cells.length,
      questionsMissingBulletCitations,
      bulletBlindSpotCount: bulletBlindSpots.length,
    },
  };
}

/**
 * Pick the next N (task_statement, bloom_level) targets to fill, prioritizing
 * cells with the largest gap so the bank fills in breadth-first rather than
 * stacking extra questions on already-strong cells. Stable ordering: primary
 * by gap desc, secondary by task_statement orderIndex asc, tertiary by bloom
 * level asc. Caller controls how many to request.
 */
export function selectFillTargets(
  report: CoverageReport,
  n: number,
): Array<{ taskStatementId: string; bloomLevel: CoverageBloomLevel }> {
  if (n <= 0) return [];
  const expanded: Array<{
    taskStatementId: string;
    bloomLevel: CoverageBloomLevel;
    gap: number;
  }> = [];
  for (const cell of report.gaps) {
    for (let i = 0; i < cell.gap; i++) {
      expanded.push({
        taskStatementId: cell.taskStatementId,
        bloomLevel: cell.bloomLevel,
        gap: cell.gap - i,
      });
    }
  }
  expanded.sort((a, b) => {
    if (b.gap !== a.gap) return b.gap - a.gap;
    const tsCmp = a.taskStatementId.localeCompare(b.taskStatementId);
    if (tsCmp !== 0) return tsCmp;
    return a.bloomLevel - b.bloomLevel;
  });
  return expanded
    .slice(0, n)
    .map(({ taskStatementId, bloomLevel }) => ({
      taskStatementId,
      bloomLevel,
    }));
}

/**
 * Retires a question from rotation (flag-as-wrong; FR3.6). Transitions
 * status from 'active' to 'retired'. No-op if already retired; returns
 * { ok: false, reason: "not_found" } if the id doesn't exist. Drill pools
 * filter on status='active' so retired questions drop out on the next run.
 */
export function flagQuestion(
  questionId: string,
  db: Db = getAppDb(),
): { ok: true; previousStatus: string } | { ok: false; reason: "not_found" } {
  const current = db
    .select({ id: schema.questions.id, status: schema.questions.status })
    .from(schema.questions)
    .where(eq(schema.questions.id, questionId))
    .get();
  if (!current) return { ok: false, reason: "not_found" };
  if (current.status === "retired") {
    return { ok: true, previousStatus: "retired" };
  }
  db.update(schema.questions)
    .set({ status: "retired" })
    .where(and(eq(schema.questions.id, questionId)))
    .run();
  return { ok: true, previousStatus: current.status };
}
