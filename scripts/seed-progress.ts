#!/usr/bin/env tsx
/**
 * Dev-only: write a synthetic stream of progress events so the mastery UI has
 * something to render before the real learning loops land. Idempotent per run
 * (events are append-only, but re-running just piles on more — that's fine for
 * dev inspection). Safe to point at app.sqlite; strip events by deleting from
 * progress_events + mastery_snapshots if you need a clean slate.
 *
 * Usage: npm run seed:progress  [--count=N]  [--ts-id=TS3]
 */
import { getAppDb, schema } from "../lib/db";
import { writeProgressEvent } from "../lib/progress/events";
import type { BloomLevel } from "../lib/progress/mastery";

const DAY_MS = 1000 * 60 * 60 * 24;

function parseArgs(): { count: number; taskStatementId: string | null } {
  let count = 40;
  let taskStatementId: string | null = null;
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("--count=")) {
      count = Number(arg.slice("--count=".length));
    } else if (arg.startsWith("--ts-id=")) {
      taskStatementId = arg.slice("--ts-id=".length);
    }
  }
  return { count, taskStatementId };
}

async function main(): Promise<void> {
  const { count, taskStatementId: cliTsId } = parseArgs();
  const db = getAppDb();

  let tsId = cliTsId;
  if (!tsId) {
    const first = db
      .select({ id: schema.taskStatements.id })
      .from(schema.taskStatements)
      .limit(1)
      .get();
    if (!first) {
      console.error(
        "No task statements found. Run `npm run ingest` first to populate the curriculum.",
      );
      process.exit(1);
    }
    tsId = first.id;
  }

  console.log(`Seeding ${count} synthetic progress events for ${tsId}…`);

  // Rough shape: user is strong at Remember/Understand, uneven at Apply,
  // and just starting Analyze. Recent-biased with some older failures.
  const levelPlan: Array<{
    level: BloomLevel;
    successRate: number;
    ageRangeDays: [number, number];
    n: number;
  }> = [
    { level: 1, successRate: 0.95, ageRangeDays: [0, 10], n: Math.ceil(count * 0.25) },
    { level: 2, successRate: 0.85, ageRangeDays: [0, 14], n: Math.ceil(count * 0.3) },
    { level: 3, successRate: 0.6, ageRangeDays: [0, 30], n: Math.ceil(count * 0.25) },
    { level: 4, successRate: 0.4, ageRangeDays: [0, 45], n: Math.ceil(count * 0.2) },
  ];

  let written = 0;
  const now = Date.now();
  for (const plan of levelPlan) {
    for (let i = 0; i < plan.n; i++) {
      const [minAge, maxAge] = plan.ageRangeDays;
      const ageDays = minAge + Math.random() * (maxAge - minAge);
      const ts = new Date(now - ageDays * DAY_MS);
      const success = Math.random() < plan.successRate;
      writeProgressEvent(
        {
          kind: "mcq_answer",
          taskStatementId: tsId,
          bloomLevel: plan.level,
          success,
          payload: { seeded: true, plannedRate: plan.successRate },
          ts,
        },
        db,
      );
      written++;
    }
  }

  console.log(`✓ Wrote ${written} events.`);

  const snaps = db
    .select()
    .from(schema.masterySnapshots)
    .all()
    .filter((s) => s.taskStatementId === tsId);
  console.log("Snapshots:");
  for (const s of snaps.sort((a, b) => a.bloomLevel - b.bloomLevel)) {
    console.log(
      `  L${s.bloomLevel}: score=${s.score.toFixed(1)}  n=${s.itemCount}`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
