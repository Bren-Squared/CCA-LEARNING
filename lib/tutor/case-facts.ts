import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../db";
import { getAppDb, schema } from "../db";
import { readSettings } from "../settings";
import {
  BLOOM_LEVELS,
  type BloomLevel,
  ceilingLevel,
  computeLevelScore,
  nextLevel,
  type ScoredEvent,
} from "../progress/mastery";

/**
 * D5.1 — the tutor's system prompt is rebuilt from scratch every turn. Case
 * facts are the current topic title, Bloom bullets, current ceiling, and the
 * last few recorded misses. That means the model can't drift off a stale
 * view of progress — the DB is always the source of truth.
 */

const MAX_RECENT_MISSES = 5;

export interface CaseFacts {
  taskStatementId: string;
  domainId: string;
  title: string;
  knowledgeBullets: string[];
  skillsBullets: string[];
  ceiling: BloomLevel | 0;
  nextLevel: BloomLevel;
  recentMisses: Array<{
    ts: Date;
    bloomLevel: number;
    kind: string;
    note?: string;
  }>;
}

export class CaseFactsError extends Error {
  readonly code: "not_found";
  constructor(code: "not_found", message: string) {
    super(message);
    this.code = code;
    this.name = "CaseFactsError";
  }
}

function formatBulletList(bullets: string[]): string {
  if (bullets.length === 0) return "- (none recorded in the exam guide)";
  return bullets.map((b) => `- ${b}`).join("\n");
}

function formatRecentMisses(misses: CaseFacts["recentMisses"]): string {
  if (misses.length === 0) return "- (no recent failures — clean slate)";
  return misses
    .map((m) => {
      const when = m.ts.toISOString().slice(0, 16).replace("T", " ");
      const note = m.note ? ` — ${m.note}` : "";
      return `- ${when} · L${m.bloomLevel} · ${m.kind}${note}`;
    })
    .join("\n");
}

/**
 * Read the TS row, compute per-level scores + ceiling, and load the last N
 * failed progress events to surface in the system prompt.
 */
export function buildCaseFacts(
  taskStatementId: string,
  opts: { db?: Db; now?: number; halfLifeDays?: number } = {},
): CaseFacts {
  const db = opts.db ?? getAppDb();
  const now = opts.now ?? Date.now();

  const row = db
    .select()
    .from(schema.taskStatements)
    .where(eq(schema.taskStatements.id, taskStatementId))
    .get();
  if (!row) {
    throw new CaseFactsError(
      "not_found",
      `task statement "${taskStatementId}" not found`,
    );
  }

  const halfLifeDays = opts.halfLifeDays ?? readSettings(db).reviewHalfLifeDays;

  // Per-level score map from raw events (cheap at single-user scale).
  const events = db
    .select({
      success: schema.progressEvents.success,
      ts: schema.progressEvents.ts,
      bloomLevel: schema.progressEvents.bloomLevel,
    })
    .from(schema.progressEvents)
    .where(eq(schema.progressEvents.taskStatementId, taskStatementId))
    .all();

  const perLevel: Partial<Record<BloomLevel, ReturnType<typeof computeLevelScore>>> = {};
  for (const level of BLOOM_LEVELS) {
    const levelEvents: ScoredEvent[] = events
      .filter((e) => e.bloomLevel === level)
      .map((e) => ({ success: e.success, ts: e.ts.getTime() }));
    perLevel[level] = computeLevelScore(levelEvents, { now, halfLifeDays });
  }

  const ceiling = ceilingLevel(perLevel);
  const next = nextLevel(perLevel);

  // Recent failures from the log — most-recent-first, capped at MAX_RECENT_MISSES.
  const missRows = db
    .select({
      ts: schema.progressEvents.ts,
      bloomLevel: schema.progressEvents.bloomLevel,
      kind: schema.progressEvents.kind,
      payload: schema.progressEvents.payload,
    })
    .from(schema.progressEvents)
    .where(
      and(
        eq(schema.progressEvents.taskStatementId, taskStatementId),
        eq(schema.progressEvents.success, false),
      ),
    )
    .orderBy(desc(schema.progressEvents.ts))
    .limit(MAX_RECENT_MISSES)
    .all();

  const recentMisses = missRows.map((m) => {
    const noteRaw = (m.payload as { note?: unknown } | null)?.note;
    return {
      ts: m.ts,
      bloomLevel: m.bloomLevel,
      kind: m.kind,
      note: typeof noteRaw === "string" ? noteRaw : undefined,
    };
  });

  return {
    taskStatementId: row.id,
    domainId: row.domainId,
    title: row.title,
    knowledgeBullets: row.knowledgeBullets,
    skillsBullets: row.skillsBullets,
    ceiling,
    nextLevel: next,
    recentMisses,
  };
}

/**
 * Format a CaseFacts object into the `{{...}}` substitution map the tutor
 * system-prompt template expects.
 */
export function caseFactsToPromptInputs(cf: CaseFacts): Record<string, string> {
  return {
    task_statement_id: cf.taskStatementId,
    title: cf.title,
    domain_id: cf.domainId,
    knowledge_bullets: formatBulletList(cf.knowledgeBullets),
    skills_bullets: formatBulletList(cf.skillsBullets),
    ceiling: String(cf.ceiling),
    next_level: String(cf.nextLevel),
    recent_misses: formatRecentMisses(cf.recentMisses),
  };
}
