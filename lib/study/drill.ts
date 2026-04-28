import { and, asc, eq, inArray, lte } from "drizzle-orm";
import type { Db } from "../db";
import { getAppDb, schema } from "../db";
import { predictedAccuracy } from "../progress/elo";
import type { BloomLevel } from "../progress/mastery";

/**
 * Drill scope. `type: "all"` pulls from every active question in the bank.
 * `type: "domain"` walks the task_statements → questions chain; `task` is a
 * single TS; `scenario` filters by questions.scenario_id; `due-mcq` (E2/AT21)
 * pulls items whose SRS state has them due for re-test.
 */
export type DrillScope =
  | { type: "all" }
  | { type: "domain"; id: string }
  | { type: "task"; id: string }
  | { type: "scenario"; id: string }
  | { type: "due-mcq" };

export interface DrillQuestion {
  id: string;
  stem: string;
  options: string[];
  correctIndex: number;
  explanations: string[];
  taskStatementId: string;
  taskStatementTitle: string;
  domainId: string;
  bloomLevel: number;
  source: "seed" | "generated";
  /** Phase 17 / E4 — current Glicko rating; 1500 prior on cold rows. */
  eloRating?: number;
  attemptsCount?: number;
}

export interface DrillPool {
  questions: DrillQuestion[];
  /** Total active questions available in the scope before the limit was applied. */
  availableCount: number;
  scope: DrillScope;
}

export const DEFAULT_DRILL_LIMIT = 10;

/**
 * Phase 17 / E4 — minimum attempts on a question before its Elo rating is
 * trusted as a difficulty signal. Below this floor the rating is dominated
 * by the 1500 prior, so the targetSuccessRate weighting falls back to the
 * legacy seed shuffle to avoid biasing on noise.
 */
export const ELO_MIN_ATTEMPTS = 5;

/**
 * Deterministic xorshift32 PRNG. Seeded shuffle is useful for reproducible
 * review sessions and for tests — Math.random would make both a pain.
 */
function seededShuffle<T>(items: T[], seed: number): T[] {
  const out = items.slice();
  let state = seed >>> 0;
  if (state === 0) state = 1;
  for (let i = out.length - 1; i > 0; i--) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function filterTaskStatementIds(scope: DrillScope, db: Db): string[] | null {
  if (scope.type === "all") return null;
  if (scope.type === "task") return [scope.id];
  if (scope.type === "domain") {
    return db
      .select({ id: schema.taskStatements.id })
      .from(schema.taskStatements)
      .where(eq(schema.taskStatements.domainId, scope.id))
      .all()
      .map((r) => r.id);
  }
  // scenario / due-mcq: no TS filter — scope is applied separately
  return null;
}

/**
 * Build a drill pool for the given scope. Pulls active questions, shuffles
 * them deterministically by seed, caps at `limit`. `availableCount` reports
 * the pre-cap total so the UI can surface "need more questions" when the
 * bank is under-filled. No Claude calls — this is strictly a DB read.
 *
 * `due-mcq` scope is special-cased: it joins `mcq_review_state`, filters to
 * items due at-or-before `now`, and orders by `due_at ASC` (most overdue
 * first) — not seed-shuffled, because the SRS scheduler already imposes a
 * meaningful order.
 */
export function buildDrillPool(
  scope: DrillScope,
  opts: {
    db?: Db;
    limit?: number;
    seed?: number;
    bloomLevel?: BloomLevel;
    /** Override `now` (ms) for `due-mcq` scope; defaults to `Date.now()`. */
    now?: number;
    /**
     * Phase 17 / E4 — when set, weights candidate questions toward the user's
     * current cell rating so predicted accuracy ≈ this target (the "desirable
     * difficulty" zone, typically ~0.7). Falls back to seed-shuffle for
     * questions with `attempts_count < ELO_MIN_ATTEMPTS`.
     */
    targetSuccessRate?: number;
  } = {},
): DrillPool {
  const db = opts.db ?? getAppDb();
  const limit = opts.limit ?? DEFAULT_DRILL_LIMIT;
  const seed = opts.seed ?? Math.floor(Math.random() * 0x7fffffff);

  if (scope.type === "due-mcq") {
    return buildDueMcqDrillPool(db, limit, opts.now ?? Date.now(), opts.bloomLevel);
  }

  const tsIds = filterTaskStatementIds(scope, db);
  const tsFilter =
    tsIds !== null
      ? inArray(schema.questions.taskStatementId, tsIds)
      : undefined;

  const activeFilter = eq(schema.questions.status, "active");
  const scenarioFilter =
    scope.type === "scenario"
      ? eq(schema.questions.scenarioId, scope.id)
      : undefined;
  const bloomFilter =
    opts.bloomLevel !== undefined
      ? eq(schema.questions.bloomLevel, opts.bloomLevel)
      : undefined;

  const filters = [activeFilter, tsFilter, scenarioFilter, bloomFilter].filter(
    (f): f is NonNullable<typeof f> => f !== undefined,
  );

  const rawRows = db
    .select({
      id: schema.questions.id,
      stem: schema.questions.stem,
      options: schema.questions.options,
      correctIndex: schema.questions.correctIndex,
      explanations: schema.questions.explanations,
      taskStatementId: schema.questions.taskStatementId,
      bloomLevel: schema.questions.bloomLevel,
      source: schema.questions.source,
      eloRating: schema.questions.eloRating,
      attemptsCount: schema.questions.attemptsCount,
    })
    .from(schema.questions)
    .where(filters.length === 1 ? filters[0] : and(...filters))
    .all();

  // Pull TS titles + domain for the task-statement summary on the end screen.
  const tsRows = db
    .select({
      id: schema.taskStatements.id,
      title: schema.taskStatements.title,
      domainId: schema.taskStatements.domainId,
    })
    .from(schema.taskStatements)
    .all();
  const tsMap = new Map(tsRows.map((t) => [t.id, t]));

  const questions: DrillQuestion[] = rawRows.map((r) => {
    const ts = tsMap.get(r.taskStatementId);
    return {
      id: r.id,
      stem: r.stem,
      options: r.options,
      correctIndex: r.correctIndex,
      explanations: r.explanations,
      taskStatementId: r.taskStatementId,
      taskStatementTitle: ts?.title ?? r.taskStatementId,
      domainId: ts?.domainId ?? "",
      bloomLevel: r.bloomLevel,
      source: r.source,
      eloRating: r.eloRating,
      attemptsCount: r.attemptsCount,
    };
  });

  // Phase 17 / E4 — desirable-difficulty weighting. When the caller asks for
  // a target success rate (typical exam-prep value ≈ 0.7), we score each
  // calibrated question by closeness to the user's predicted accuracy on it,
  // then sample by score. Cold questions (< ELO_MIN_ATTEMPTS) fall back to
  // the legacy seed shuffle so we don't bias on a 1500-prior.
  if (
    opts.targetSuccessRate !== undefined &&
    opts.targetSuccessRate >= 0 &&
    opts.targetSuccessRate <= 1
  ) {
    const userRating = pickUserRating(db, scope, opts.bloomLevel);
    const ranked = rankByDesirableDifficulty(
      questions,
      userRating,
      opts.targetSuccessRate,
      seed,
    );
    return {
      questions: ranked.slice(0, limit),
      availableCount: ranked.length,
      scope,
    };
  }

  const shuffled = seededShuffle(questions, seed);
  return {
    questions: shuffled.slice(0, limit),
    availableCount: shuffled.length,
    scope,
  };
}

/**
 * Pull the user's mean Elo rating across the cells matching the drill scope.
 * Returns the default 1500 prior when nothing has been calibrated yet — the
 * targetSuccessRate weighting still produces a sensible ordering against an
 * uncalibrated user (cold questions land in the seed-shuffle fallback).
 */
function pickUserRating(
  db: Db,
  scope: DrillScope,
  bloomLevel: BloomLevel | undefined,
): number {
  const rows = db.select().from(schema.userSkill).all();
  if (rows.length === 0) return 1500;

  let relevant = rows;
  if (scope.type === "task") {
    relevant = rows.filter((r) => r.taskStatementId === scope.id);
  } else if (scope.type === "domain") {
    const tsIds = db
      .select({ id: schema.taskStatements.id })
      .from(schema.taskStatements)
      .where(eq(schema.taskStatements.domainId, scope.id))
      .all()
      .map((r) => r.id);
    const set = new Set(tsIds);
    relevant = rows.filter((r) => set.has(r.taskStatementId));
  }
  if (bloomLevel !== undefined) {
    relevant = relevant.filter((r) => r.bloomLevel === bloomLevel);
  }
  if (relevant.length === 0) return 1500;
  const total = relevant.reduce((s, r) => s + r.eloRating * r.attemptsCount, 0);
  const weight = relevant.reduce((s, r) => s + r.attemptsCount, 0);
  return weight > 0 ? total / weight : 1500;
}

/**
 * Rank questions by closeness of their predicted accuracy to the target,
 * with cold (low-attempts) questions interleaved by seed shuffle. Stable
 * ordering: closeness desc, then deterministic shuffle for ties / cold rows.
 */
function rankByDesirableDifficulty(
  questions: DrillQuestion[],
  userRating: number,
  target: number,
  seed: number,
): DrillQuestion[] {
  const calibrated: Array<{ q: DrillQuestion; closeness: number }> = [];
  const cold: DrillQuestion[] = [];
  for (const q of questions) {
    if ((q.attemptsCount ?? 0) >= ELO_MIN_ATTEMPTS) {
      const predicted = predictedAccuracy(userRating, q.eloRating ?? 1500);
      calibrated.push({ q, closeness: 1 - Math.abs(predicted - target) });
    } else {
      cold.push(q);
    }
  }
  calibrated.sort((a, b) => b.closeness - a.closeness);
  const shuffledCold = seededShuffle(cold, seed);
  return [...calibrated.map((c) => c.q), ...shuffledCold];
}

function buildDueMcqDrillPool(
  db: Db,
  limit: number,
  nowMs: number,
  bloomLevel: BloomLevel | undefined,
): DrillPool {
  const tsRows = db
    .select({
      id: schema.taskStatements.id,
      title: schema.taskStatements.title,
      domainId: schema.taskStatements.domainId,
    })
    .from(schema.taskStatements)
    .all();
  const tsMap = new Map(tsRows.map((t) => [t.id, t]));
  const nowDate = new Date(nowMs);

  const filters = [
    lte(schema.mcqReviewState.dueAt, nowDate),
    eq(schema.questions.status, "active"),
  ];
  if (bloomLevel !== undefined) {
    filters.push(eq(schema.questions.bloomLevel, bloomLevel));
  }

  const rows = db
    .select({
      id: schema.questions.id,
      stem: schema.questions.stem,
      options: schema.questions.options,
      correctIndex: schema.questions.correctIndex,
      explanations: schema.questions.explanations,
      taskStatementId: schema.questions.taskStatementId,
      bloomLevel: schema.questions.bloomLevel,
      source: schema.questions.source,
      dueAt: schema.mcqReviewState.dueAt,
    })
    .from(schema.mcqReviewState)
    .innerJoin(
      schema.questions,
      eq(schema.questions.id, schema.mcqReviewState.questionId),
    )
    .where(and(...filters))
    .orderBy(asc(schema.mcqReviewState.dueAt))
    .all();

  const questions: DrillQuestion[] = rows.map((r) => {
    const ts = tsMap.get(r.taskStatementId);
    return {
      id: r.id,
      stem: r.stem,
      options: r.options,
      correctIndex: r.correctIndex,
      explanations: r.explanations,
      taskStatementId: r.taskStatementId,
      taskStatementTitle: ts?.title ?? r.taskStatementId,
      domainId: ts?.domainId ?? "",
      bloomLevel: r.bloomLevel,
      source: r.source,
    };
  });

  return {
    questions: questions.slice(0, limit),
    availableCount: questions.length,
    scope: { type: "due-mcq" },
  };
}

export interface ScopeCount {
  key: string;
  count: number;
}

/**
 * Batch version: one query, one map. Keyed by "tsId|level" for O(1) lookup
 * from the heatmap renderer. Only active questions.
 */
export function countAllActiveQuestionsByCell(
  db: Db = getAppDb(),
): Map<string, number> {
  const rows = db
    .select({
      taskStatementId: schema.questions.taskStatementId,
      bloomLevel: schema.questions.bloomLevel,
    })
    .from(schema.questions)
    .where(eq(schema.questions.status, "active"))
    .all();
  const map = new Map<string, number>();
  for (const r of rows) {
    const key = `${r.taskStatementId}|${r.bloomLevel}`;
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return map;
}

/**
 * Count active questions for a single task statement, grouped by Bloom level
 * (1..6). Missing levels are returned as 0. Used by the TS detail view to
 * render a ladder with per-row drill availability.
 */
export function countQuestionsForTaskByLevel(
  taskStatementId: string,
  db: Db = getAppDb(),
): Record<BloomLevel, number> {
  const rows = db
    .select({ bloomLevel: schema.questions.bloomLevel })
    .from(schema.questions)
    .where(
      and(
        eq(schema.questions.taskStatementId, taskStatementId),
        eq(schema.questions.status, "active"),
      ),
    )
    .all();
  const result: Record<BloomLevel, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
  for (const r of rows) {
    if (r.bloomLevel >= 1 && r.bloomLevel <= 6) {
      result[r.bloomLevel as BloomLevel] += 1;
    }
  }
  return result;
}

/**
 * Count active questions grouped by domain, task statement, and scenario.
 * Used by the launcher to render live availability next to each scope choice.
 */
export function countQuestionsByScope(db: Db = getAppDb()): {
  total: number;
  byDomain: ScopeCount[];
  byTaskStatement: ScopeCount[];
  byScenario: ScopeCount[];
} {
  const activeQuestions = db
    .select({
      taskStatementId: schema.questions.taskStatementId,
      scenarioId: schema.questions.scenarioId,
    })
    .from(schema.questions)
    .where(eq(schema.questions.status, "active"))
    .all();

  const tsRows = db
    .select({
      id: schema.taskStatements.id,
      domainId: schema.taskStatements.domainId,
    })
    .from(schema.taskStatements)
    .all();
  const domainByTs = new Map(tsRows.map((t) => [t.id, t.domainId]));

  const domainCounts = new Map<string, number>();
  const tsCounts = new Map<string, number>();
  const scenarioCounts = new Map<string, number>();
  for (const q of activeQuestions) {
    tsCounts.set(q.taskStatementId, (tsCounts.get(q.taskStatementId) ?? 0) + 1);
    const dom = domainByTs.get(q.taskStatementId);
    if (dom) domainCounts.set(dom, (domainCounts.get(dom) ?? 0) + 1);
    if (q.scenarioId)
      scenarioCounts.set(
        q.scenarioId,
        (scenarioCounts.get(q.scenarioId) ?? 0) + 1,
      );
  }

  const toList = (m: Map<string, number>): ScopeCount[] =>
    Array.from(m.entries()).map(([key, count]) => ({ key, count }));

  return {
    total: activeQuestions.length,
    byDomain: toList(domainCounts),
    byTaskStatement: toList(tsCounts),
    byScenario: toList(scenarioCounts),
  };
}
