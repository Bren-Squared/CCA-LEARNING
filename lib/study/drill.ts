import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db";
import { getAppDb, schema } from "../db";

/**
 * Drill scope. `type: "all"` pulls from every active question in the bank.
 * `type: "domain"` walks the task_statements → questions chain; `task` is a
 * single TS; `scenario` filters by questions.scenario_id.
 */
export type DrillScope =
  | { type: "all" }
  | { type: "domain"; id: string }
  | { type: "task"; id: string }
  | { type: "scenario"; id: string };

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
}

export interface DrillPool {
  questions: DrillQuestion[];
  /** Total active questions available in the scope before the limit was applied. */
  availableCount: number;
  scope: DrillScope;
}

export const DEFAULT_DRILL_LIMIT = 10;

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
  // scenario: no TS filter — scenario filter applied directly to questions
  return null;
}

/**
 * Build a drill pool for the given scope. Pulls active questions, shuffles
 * them deterministically by seed, caps at `limit`. `availableCount` reports
 * the pre-cap total so the UI can surface "need more questions" when the
 * bank is under-filled. No Claude calls — this is strictly a DB read.
 */
export function buildDrillPool(
  scope: DrillScope,
  opts: { db?: Db; limit?: number; seed?: number } = {},
): DrillPool {
  const db = opts.db ?? getAppDb();
  const limit = opts.limit ?? DEFAULT_DRILL_LIMIT;
  const seed = opts.seed ?? Math.floor(Math.random() * 0x7fffffff);

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

  const filters = [activeFilter, tsFilter, scenarioFilter].filter(
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
    };
  });

  const shuffled = seededShuffle(questions, seed);
  return {
    questions: shuffled.slice(0, limit),
    availableCount: shuffled.length,
    scope,
  };
}

export interface ScopeCount {
  key: string;
  count: number;
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
