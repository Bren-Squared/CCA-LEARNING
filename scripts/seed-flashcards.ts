#!/usr/bin/env tsx
/**
 * One-shot bulk pass: generate a flashcard deck for every task statement that
 * doesn't already have one. Idempotent — re-running skips TSs with existing
 * cards. Use `--force` to regenerate every deck (appends, does not replace;
 * prior cards keep their SM-2 state).
 *
 * Hits the Claude API once per TS. No Batches API — we author small decks
 * (3-5 cards) and the per-TS latency is tolerable. For AT3 we need ≥ 30 cards
 * across ≥ 30 TSs, which is one call per TS.
 *
 * Usage:
 *   npm run seed:flashcards                  (fill gaps only)
 *   npm run seed:flashcards -- --force       (regenerate all)
 *   npm run seed:flashcards -- --ts-id=D1.1  (single TS)
 *   npm run seed:flashcards -- --limit=5     (first N gaps, for smoke testing)
 */
import { getAppDb, schema } from "../lib/db";
import { getOrGenerateDeck } from "../lib/study/cards";
import { asc, eq } from "drizzle-orm";

interface Args {
  force: boolean;
  tsId: string | null;
  limit: number | null;
}

function parseArgs(): Args {
  const args: Args = { force: false, tsId: null, limit: null };
  for (const arg of process.argv.slice(2)) {
    if (arg === "--force") args.force = true;
    else if (arg.startsWith("--ts-id=")) args.tsId = arg.slice("--ts-id=".length);
    else if (arg.startsWith("--limit=")) args.limit = Number(arg.slice("--limit=".length));
  }
  return args;
}

async function main(): Promise<void> {
  const { force, tsId, limit } = parseArgs();
  const db = getAppDb();

  const taskStatements = tsId
    ? db
        .select()
        .from(schema.taskStatements)
        .where(eq(schema.taskStatements.id, tsId))
        .all()
    : db
        .select()
        .from(schema.taskStatements)
        .orderBy(asc(schema.taskStatements.orderIndex))
        .all();

  if (taskStatements.length === 0) {
    console.error(
      "No task statements found. Run `npm run ingest` first to populate the curriculum.",
    );
    process.exit(1);
  }

  const targets = limit ? taskStatements.slice(0, limit) : taskStatements;
  console.log(
    `Checking ${targets.length} task statement${targets.length === 1 ? "" : "s"}${force ? " (--force)" : ""}…`,
  );

  let generated = 0;
  let skipped = 0;
  let cardsWritten = 0;

  for (const ts of targets) {
    const existing = db
      .select({ id: schema.flashcards.id })
      .from(schema.flashcards)
      .where(eq(schema.flashcards.taskStatementId, ts.id))
      .all();
    if (existing.length > 0 && !force) {
      skipped++;
      continue;
    }
    try {
      const { cards, cached } = await getOrGenerateDeck(ts.id, {
        db,
        forceRegenerate: force,
      });
      if (cached && !force) {
        skipped++;
      } else {
        generated++;
        cardsWritten += cards.length;
        console.log(`  ${ts.id}  +${cards.length} card${cards.length === 1 ? "" : "s"}`);
      }
    } catch (err) {
      console.error(`  ${ts.id}  FAILED: ${(err as Error).message}`);
    }
  }

  const totalCards = db.select({ id: schema.flashcards.id }).from(schema.flashcards).all().length;
  console.log(
    `\n✓ Generated ${generated} deck${generated === 1 ? "" : "s"} (${cardsWritten} cards). Skipped ${skipped}. Total cards in DB: ${totalCards}.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
