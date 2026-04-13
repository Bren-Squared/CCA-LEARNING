import { asc, count } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getAppDb, schema } from "@/lib/db";
import {
  BLOOM_LEVELS,
  type BloomLevel,
  domainSummary,
  isMastered,
  taskStatementSummary,
} from "@/lib/progress/mastery";

/**
 * GET /api/debug/mastery — inspect decay-weighted mastery for the whole tree.
 * Dev-only verification endpoint; not wired into the UI. Returns domain rollups,
 * per-task-statement OD2 summaries, and per-Bloom-level snapshots.
 */
export async function GET() {
  try {
    const db = getAppDb();

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
    const eventCountRow = db
      .select({ n: count() })
      .from(schema.progressEvents)
      .get();
    const totalEvents = eventCountRow?.n ?? 0;

    const snapshotsByTs = new Map<string, typeof snapshots>();
    for (const s of snapshots) {
      const list = snapshotsByTs.get(s.taskStatementId) ?? [];
      list.push(s);
      snapshotsByTs.set(s.taskStatementId, list);
    }

    const tsByDomain = new Map<string, typeof taskStatements>();
    for (const ts of taskStatements) {
      const list = tsByDomain.get(ts.domainId) ?? [];
      list.push(ts);
      tsByDomain.set(ts.domainId, list);
    }

    const domainPayload = domains.map((d) => {
      const tsList = tsByDomain.get(d.id) ?? [];
      const tsSummaries: number[] = [];

      const taskStatementsPayload = tsList.map((ts) => {
        const snaps = snapshotsByTs.get(ts.id) ?? [];
        const levelMap: Partial<Record<BloomLevel, number>> = {};
        const levels = BLOOM_LEVELS.map((level) => {
          const snap = snaps.find((s) => s.bloomLevel === level);
          const score = snap?.score ?? 0; // 0..100
          const itemCount = snap?.itemCount ?? 0;
          levelMap[level] = score / 100; // back to 0..1 for summary math
          return {
            level,
            score,
            itemCount,
            mastered: isMastered({ score: score / 100, itemCount }),
          };
        });
        const summary = taskStatementSummary(levelMap);
        tsSummaries.push(summary);
        return { id: ts.id, title: ts.title, summary, levels };
      });

      return {
        id: d.id,
        title: d.title,
        weightBps: d.weightBps,
        summary: domainSummary(tsSummaries),
        taskStatements: taskStatementsPayload,
      };
    });

    return NextResponse.json({
      totalEvents,
      domains: domainPayload,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
