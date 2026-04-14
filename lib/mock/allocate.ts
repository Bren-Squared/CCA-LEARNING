import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db";
import { getAppDb, schema } from "../db";
import type { BloomLevel } from "../progress/mastery";

/**
 * Mock-exam question allocator (FR2.6).
 *
 * Picks 4 of 6 scenarios at random and 60 active questions drawn from the
 * Apply–Evaluate Bloom band (levels 3–5). Per-domain counts follow the
 * exam's 27/18/20/20/15 weighting via largest-remainder apportionment, so
 * the mock reflects exam composition as closely as 60 questions allow.
 *
 * Not adaptive: the mock is meant to simulate real conditions (FR2.6), so
 * it does not bias toward the user's current Bloom ceiling.
 */

export const MOCK_TOTAL_QUESTIONS = 60;
export const MOCK_SCENARIO_COUNT = 4;
export const MOCK_BLOOM_BAND: readonly BloomLevel[] = [3, 4, 5] as const;
export const MOCK_DURATION_MS = 120 * 60 * 1000;

/**
 * Domain weight in basis points (sum = 10000). Hard-coded here rather than
 * pulled from the `domains` table so the allocator is self-contained and
 * auditable — the values are load-bearing and changing them silently would
 * quietly re-shape every future mock exam.
 */
export const MOCK_DOMAIN_WEIGHTS_BPS: Record<string, number> = {
  D1: 2700,
  D2: 1800,
  D3: 2000,
  D4: 2000,
  D5: 1500,
};

export class MockAllocationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "MockAllocationError";
  }
}

export interface MockAllocation {
  /** The 4 scenario ids selected (order stable within an allocation). */
  scenarioIds: string[];
  /** Exactly `MOCK_TOTAL_QUESTIONS` question ids, in presentation order. */
  questionIds: string[];
  /** Per-domain target counts (sums to MOCK_TOTAL_QUESTIONS). */
  domainTargets: Record<string, number>;
  /** Per-domain actual counts after allocation (sums to MOCK_TOTAL_QUESTIONS). */
  domainActual: Record<string, number>;
  /** Diagnostic — domains where the bank ran short and we topped up. */
  shortfallDomains: string[];
}

export interface BuildMockAllocationOpts {
  db?: Db;
  /** Deterministic seed for scenario pick + question shuffles (tests). */
  seed?: number;
  /** Override total question count (tests only). */
  totalQuestions?: number;
}

/**
 * xorshift32 — same PRNG used by the drill allocator so seeded tests are
 * reproducible against either code path.
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

/**
 * Largest-remainder (Hamilton) apportionment. Floors each ideal quota,
 * then distributes leftover seats to the largest fractional remainders.
 * Ties broken by the order the domains appear in `weightsBps`, which is
 * stable because `MOCK_DOMAIN_WEIGHTS_BPS` is a literal object.
 */
export function allocateByLargestRemainder(
  total: number,
  weightsBps: Record<string, number>,
): Record<string, number> {
  const keys = Object.keys(weightsBps);
  const totalBps = keys.reduce((s, k) => s + weightsBps[k], 0);
  if (totalBps <= 0) {
    throw new MockAllocationError(
      "invalid_weights",
      "weight basis points must sum to a positive number",
    );
  }

  const ideal = keys.map((k) => (total * weightsBps[k]) / totalBps);
  const floors = ideal.map((x) => Math.floor(x));
  const assigned = floors.reduce((s, n) => s + n, 0);
  let remaining = total - assigned;

  const ranked = keys
    .map((k, i) => ({ key: k, remainder: ideal[i] - floors[i], index: i }))
    .sort((a, b) => {
      if (b.remainder !== a.remainder) return b.remainder - a.remainder;
      return a.index - b.index;
    });

  const out: Record<string, number> = {};
  keys.forEach((k, i) => {
    out[k] = floors[i];
  });
  for (const r of ranked) {
    if (remaining <= 0) break;
    out[r.key] += 1;
    remaining -= 1;
  }
  return out;
}

interface QuestionRow {
  id: string;
  taskStatementId: string;
  scenarioId: string | null;
  domainId: string;
  bloomLevel: number;
}

function loadExamBandQuestions(db: Db): QuestionRow[] {
  const rows = db
    .select({
      id: schema.questions.id,
      taskStatementId: schema.questions.taskStatementId,
      scenarioId: schema.questions.scenarioId,
      bloomLevel: schema.questions.bloomLevel,
      domainId: schema.taskStatements.domainId,
    })
    .from(schema.questions)
    .innerJoin(
      schema.taskStatements,
      eq(schema.taskStatements.id, schema.questions.taskStatementId),
    )
    .where(
      and(
        eq(schema.questions.status, "active"),
        inArray(
          schema.questions.bloomLevel,
          MOCK_BLOOM_BAND as unknown as number[],
        ),
      ),
    )
    .all();
  return rows;
}

/**
 * Pick `n` scenario ids at random from the full scenarios table.
 *
 * Errors out if the DB has fewer than `n` scenarios; we never want a mock
 * exam to silently attempt with a degraded scenario count because the
 * ingest ran against a truncated guide.
 */
export function pickScenarios(
  db: Db,
  n: number,
  seed: number,
): string[] {
  const all = db
    .select({ id: schema.scenarios.id })
    .from(schema.scenarios)
    .all();
  if (all.length < n) {
    throw new MockAllocationError(
      "insufficient_scenarios",
      `mock exam requires ${n} scenarios but only ${all.length} are ingested`,
    );
  }
  const shuffled = seededShuffle(
    all.map((r) => r.id),
    seed,
  );
  return shuffled.slice(0, n).sort();
}

/**
 * Build a full 60-question allocation. Rolls a seeded shuffle over the
 * candidate questions per domain, prefers questions tied to the four
 * selected scenarios, and falls back to same-domain scenario-less or
 * off-scenario questions when a preferred bucket runs short.
 *
 * Throws `insufficient_questions` when the bank cannot satisfy the full
 * 60 — callers should surface a generator-backfill hint to the user.
 */
export function buildMockAllocation(
  opts: BuildMockAllocationOpts = {},
): MockAllocation {
  const db = opts.db ?? getAppDb();
  const total = opts.totalQuestions ?? MOCK_TOTAL_QUESTIONS;
  const seed = opts.seed ?? Math.floor(Math.random() * 0x7fffffff);

  const scenarioIds = pickScenarios(db, MOCK_SCENARIO_COUNT, seed);
  const scenarioSet = new Set(scenarioIds);

  const domainTargets = allocateByLargestRemainder(
    total,
    MOCK_DOMAIN_WEIGHTS_BPS,
  );

  const candidates = loadExamBandQuestions(db);
  const byDomain = new Map<string, QuestionRow[]>();
  for (const dom of Object.keys(MOCK_DOMAIN_WEIGHTS_BPS)) byDomain.set(dom, []);
  for (const q of candidates) {
    const bucket = byDomain.get(q.domainId);
    if (bucket) bucket.push(q);
  }

  const picked: QuestionRow[] = [];
  const domainActual: Record<string, number> = {};
  const shortfallDomains: string[] = [];

  let rollingSeed = seed;
  function nextSeed(): number {
    rollingSeed = (rollingSeed * 1103515245 + 12345) >>> 0;
    return rollingSeed || 1;
  }

  for (const dom of Object.keys(MOCK_DOMAIN_WEIGHTS_BPS)) {
    const target = domainTargets[dom];
    const pool = byDomain.get(dom) ?? [];
    const preferred = seededShuffle(
      pool.filter((q) => q.scenarioId !== null && scenarioSet.has(q.scenarioId)),
      nextSeed(),
    );
    const fallback = seededShuffle(
      pool.filter(
        (q) => q.scenarioId === null || !scenarioSet.has(q.scenarioId),
      ),
      nextSeed(),
    );

    const chosen = preferred.slice(0, target);
    if (chosen.length < target) {
      const need = target - chosen.length;
      chosen.push(...fallback.slice(0, need));
    }
    if (chosen.length < target) shortfallDomains.push(dom);
    domainActual[dom] = chosen.length;
    picked.push(...chosen);
  }

  const totalPicked = picked.length;
  if (totalPicked < total) {
    throw new MockAllocationError(
      "insufficient_questions",
      `mock exam requires ${total} active Apply–Evaluate questions but the bank only yielded ${totalPicked} (short on: ${shortfallDomains.join(", ") || "none"})`,
    );
  }

  const presentationOrder = seededShuffle(picked, nextSeed());
  return {
    scenarioIds,
    questionIds: presentationOrder.map((q) => q.id),
    domainTargets,
    domainActual,
    shortfallDomains,
  };
}
