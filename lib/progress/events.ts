import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db, DbClient } from "../db";
import { schema } from "../db";
import { readSettings } from "../settings";
import {
  type BloomLevel,
  computeLevelScore,
  type ScoredEvent,
} from "./mastery";

type EventKind = typeof schema.progressEvents.$inferInsert.kind;

export interface WriteProgressEventInput {
  kind: EventKind;
  taskStatementId: string;
  bloomLevel: BloomLevel;
  success: boolean;
  payload?: Record<string, unknown>;
  /** Optional override — defaults to Date.now() at write time */
  ts?: Date;
}

/**
 * Append a progress event and refresh the (taskStatementId, bloomLevel)
 * snapshot in one transaction. Progress events are immutable; the snapshot
 * is a derived cache of decay-weighted level score + raw item count.
 *
 * Snapshot score is stored as 0..100 to match the spec wording
 * ("accuracy score 0-100") — internal math uses 0..1 and multiplies on write.
 */
export function writeProgressEvent(
  input: WriteProgressEventInput,
  db: Db,
): { eventId: string; score: number; itemCount: number } {
  const halfLifeDays = readSettings(db).reviewHalfLifeDays;

  const eventId = randomUUID();
  const ts = input.ts ?? new Date();
  const payload = input.payload ?? {};

  return db.transaction((tx) => {
    tx.insert(schema.progressEvents)
      .values({
        id: eventId,
        ts,
        kind: input.kind,
        taskStatementId: input.taskStatementId,
        bloomLevel: input.bloomLevel,
        success: input.success,
        payload,
      })
      .run();

    const { score, itemCount } = refreshSnapshot(
      input.taskStatementId,
      input.bloomLevel,
      { now: ts.getTime(), halfLifeDays },
      tx,
    );

    return { eventId, score, itemCount };
  });
}

/**
 * Recompute the snapshot for one (taskStatementId, bloomLevel) pair from the
 * event log and upsert it into mastery_snapshots. Exposed for the seed script
 * and tests; callers in app code should use writeProgressEvent, which wraps
 * this in a transaction with the append.
 */
export function refreshSnapshot(
  taskStatementId: string,
  bloomLevel: BloomLevel,
  opts: { now: number; halfLifeDays: number },
  db: DbClient,
): { score: number; itemCount: number } {
  const rows = db
    .select({
      success: schema.progressEvents.success,
      ts: schema.progressEvents.ts,
    })
    .from(schema.progressEvents)
    .where(
      and(
        eq(schema.progressEvents.taskStatementId, taskStatementId),
        eq(schema.progressEvents.bloomLevel, bloomLevel),
      ),
    )
    .all();

  const events: ScoredEvent[] = rows.map((r) => ({
    success: r.success,
    ts: r.ts.getTime(),
  }));

  const level = computeLevelScore(events, opts);
  const score100 = level.score * 100;

  db.insert(schema.masterySnapshots)
    .values({
      taskStatementId,
      bloomLevel,
      score: score100,
      itemCount: level.itemCount,
      updatedAt: new Date(opts.now),
    })
    .onConflictDoUpdate({
      target: [
        schema.masterySnapshots.taskStatementId,
        schema.masterySnapshots.bloomLevel,
      ],
      set: {
        score: score100,
        itemCount: level.itemCount,
        updatedAt: new Date(opts.now),
      },
    })
    .run();

  return { score: score100, itemCount: level.itemCount };
}
