import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { asc, eq, lte } from "drizzle-orm";
import { callClaude } from "../claude/client";
import { loadPromptFile } from "../claude/prompts/loader";
import {
  emitFlashcardsInputSchema,
  emitFlashcardsTool,
  type EmitFlashcardsInput,
} from "../claude/roles/card-writer";
import type { Db } from "../db";
import { getAppDb, schema } from "../db";
import { DEFAULT_EASE_FACTOR } from "../progress/sm2";

/**
 * Card-deck orchestrator. `getOrGenerateDeck(taskStatementId)` returns the
 * existing flashcards for a task statement, generating via Claude on first
 * call and caching in the `flashcards` table. Pass `forceRegenerate` to
 * re-author a deck — the prior cards are left in place (their SM-2 state has
 * real user data) and the new ones are appended, so use it sparingly.
 */

export class CardDeckError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "CardDeckError";
  }
}

export interface DeckCard {
  id: string;
  taskStatementId: string;
  front: string;
  back: string;
  bloomLevel: number;
  easeFactor: number;
  intervalDays: number;
  dueAt: Date;
  reviewsCount: number;
  lastReviewedAt: Date | null;
}

export interface DeckArtifact {
  cards: DeckCard[];
  cached: boolean;
}

function formatBullets(bullets: string[]): string {
  return bullets.map((b) => `- ${b}`).join("\n");
}

function rowToCard(row: typeof schema.flashcards.$inferSelect): DeckCard {
  return {
    id: row.id,
    taskStatementId: row.taskStatementId,
    front: row.front,
    back: row.back,
    bloomLevel: row.bloomLevel,
    easeFactor: row.easeFactor,
    intervalDays: row.intervalDays,
    dueAt: row.dueAt,
    reviewsCount: row.reviewsCount,
    lastReviewedAt: row.lastReviewedAt,
  };
}

function readDeck(taskStatementId: string, db: Db): DeckCard[] {
  const rows = db
    .select()
    .from(schema.flashcards)
    .where(eq(schema.flashcards.taskStatementId, taskStatementId))
    .orderBy(asc(schema.flashcards.createdAt))
    .all();
  return rows.map(rowToCard);
}

function extractToolInput(
  message: Awaited<ReturnType<typeof callClaude>>,
): EmitFlashcardsInput {
  for (const block of message.content) {
    if (block.type === "tool_use" && block.name === emitFlashcardsTool.name) {
      const parsed = emitFlashcardsInputSchema.safeParse(block.input);
      if (!parsed.success) {
        throw new CardDeckError(
          "bad_tool_output",
          `model returned invalid emit_flashcards payload: ${parsed.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; ")}`,
        );
      }
      return parsed.data;
    }
  }
  throw new CardDeckError(
    "no_tool_use",
    `model did not call emit_flashcards (stop_reason=${message.stop_reason})`,
  );
}

function persistDeck(
  taskStatementId: string,
  artifact: EmitFlashcardsInput,
  db: Db,
): DeckCard[] {
  const now = new Date();

  return db.transaction((tx) => {
    const inserted: DeckCard[] = [];
    for (const c of artifact.cards) {
      const id = randomUUID();
      tx.insert(schema.flashcards)
        .values({
          id,
          taskStatementId,
          front: c.front,
          back: c.back,
          bloomLevel: c.bloom_level,
          easeFactor: DEFAULT_EASE_FACTOR,
          intervalDays: 0,
          dueAt: now,
          reviewsCount: 0,
        })
        .run();
      inserted.push({
        id,
        taskStatementId,
        front: c.front,
        back: c.back,
        bloomLevel: c.bloom_level,
        easeFactor: DEFAULT_EASE_FACTOR,
        intervalDays: 0,
        dueAt: now,
        reviewsCount: 0,
        lastReviewedAt: null,
      });
    }
    return inserted;
  });
}

export async function getOrGenerateDeck(
  taskStatementId: string,
  opts: { db?: Db; forceRegenerate?: boolean } = {},
): Promise<DeckArtifact> {
  const db = opts.db ?? getAppDb();

  if (!opts.forceRegenerate) {
    const existing = readDeck(taskStatementId, db);
    if (existing.length > 0) return { cards: existing, cached: true };
  }

  const ts = db
    .select()
    .from(schema.taskStatements)
    .where(eq(schema.taskStatements.id, taskStatementId))
    .get();
  if (!ts) {
    throw new CardDeckError(
      "not_found",
      `task statement "${taskStatementId}" not found`,
    );
  }

  const template = loadPromptFile(
    resolve(process.cwd(), "prompts/card-writer.md"),
  );
  const systemPrompt = template.render({
    title: ts.title,
    knowledge_bullets: formatBullets(ts.knowledgeBullets),
    skills_bullets: formatBullets(ts.skillsBullets),
  });

  const message = await callClaude({
    role: "card-writer",
    system: systemPrompt,
    cacheSystem: true,
    messages: [
      {
        role: "user",
        content: `Author the flashcard deck for task statement ${ts.id}: "${ts.title}".`,
      },
    ],
    tools: [
      {
        name: emitFlashcardsTool.name,
        description: emitFlashcardsTool.description,
        input_schema: emitFlashcardsTool.inputSchema,
      },
    ],
    toolChoice: { type: "tool", name: emitFlashcardsTool.name },
    maxTokens: 2048,
    temperature: 0.4,
    db,
  });

  const input = extractToolInput(message);
  const cards = persistDeck(taskStatementId, input, db);
  return { cards, cached: false };
}

/**
 * Due-queue accessor — returns flashcards whose `dueAt` is ≤ `now`, ordered by
 * dueAt ascending. Used by the /study/flashcards review page.
 */
export function listDueCards(
  opts: { db?: Db; now?: Date; limit?: number } = {},
): DeckCard[] {
  const db = opts.db ?? getAppDb();
  const now = opts.now ?? new Date();
  const q = db
    .select()
    .from(schema.flashcards)
    .where(lte(schema.flashcards.dueAt, now))
    .orderBy(asc(schema.flashcards.dueAt));
  const rows = opts.limit !== undefined ? q.limit(opts.limit).all() : q.all();
  return rows.map(rowToCard);
}

/**
 * Count of due cards across the whole deck. Cheap aggregation for the
 * dashboard "Flashcards due today" pill.
 */
export function countDueCards(
  opts: { db?: Db; now?: Date } = {},
): number {
  return listDueCards(opts).length;
}

/**
 * Read-only deck accessor — used by the TS detail page to surface its own
 * cards without triggering generation. Empty array if no deck yet.
 */
export function readDeckFor(
  taskStatementId: string,
  db: Db = getAppDb(),
): DeckCard[] {
  return readDeck(taskStatementId, db);
}
