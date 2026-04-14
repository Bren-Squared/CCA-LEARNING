import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../lib/db";
import { schema } from "../lib/db";

// Mock Claude BEFORE importing the generator so the mock is live.
const callClaudeMock = vi.fn();
vi.mock("../lib/claude/client", async () => {
  const actual = await vi.importActual<typeof import("../lib/claude/client")>(
    "../lib/claude/client",
  );
  return {
    ...actual,
    callClaude: callClaudeMock,
  };
});

const { getOrGenerateDeck, listDueCards, countDueCards } = await import(
  "../lib/study/cards"
);
const { applyFlashcardGrade } = await import("../lib/study/flashcard-grade");

const DRIZZLE_DIR = resolve(process.cwd(), "drizzle");
const DAY_MS = 24 * 60 * 60 * 1000;

function allMigrationsSql(): string {
  return readdirSync(DRIZZLE_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(resolve(DRIZZLE_DIR, f), "utf8"))
    .join("\n");
}

function freshDb(): { db: Db; close: () => void } {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  for (const stmt of allMigrationsSql().split("--> statement-breakpoint")) {
    const sql = stmt.trim();
    if (sql) sqlite.exec(sql);
  }
  return { db: drizzle(sqlite, { schema }), close: () => sqlite.close() };
}

function seedTs(db: Db): void {
  db.insert(schema.domains)
    .values({ id: "D1", title: "Domain 1", weightBps: 5000, orderIndex: 1 })
    .run();
  db.insert(schema.taskStatements)
    .values({
      id: "TS1",
      domainId: "D1",
      title: "Design agentic loops",
      knowledgeBullets: ["Stop reasons", "Tool use cycles"],
      skillsBullets: ["Choosing max iterations", "Budget guards"],
      orderIndex: 1,
    })
    .run();
}

function cannedMessage() {
  return {
    id: "msg_test",
    type: "message" as const,
    role: "assistant" as const,
    model: "claude-sonnet-4-6",
    stop_reason: "tool_use" as const,
    stop_sequence: null,
    usage: {
      input_tokens: 80,
      output_tokens: 200,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation: null,
      inference_geo: null,
      server_tool_use: null,
      service_tier: null,
    },
    content: [
      {
        type: "tool_use" as const,
        id: "tu_1",
        name: "emit_flashcards",
        input: {
          cards: [
            {
              front: "Define: tool_use stop_reason",
              back: "Signals the model emitted a tool call. The caller executes the tool and appends the result before the next message.",
              bloom_level: 1,
            },
            {
              front: "Why do budget guards belong before every loop iteration?",
              back: "Checking before each iteration catches runaway tool-calling early, before it has a chance to spend budget the next step couldn't afford.",
              bloom_level: 2,
            },
            {
              front: "What happens if the model returns end_turn with no tool_use?",
              back: "The agentic loop terminates and the final text is returned to the user. This is the normal completion path.",
              bloom_level: 1,
            },
          ],
        },
      },
    ],
  };
}

describe("getOrGenerateDeck", () => {
  let handle: ReturnType<typeof freshDb>;

  beforeEach(() => {
    handle = freshDb();
    seedTs(handle.db);
    callClaudeMock.mockReset();
    callClaudeMock.mockResolvedValue(cannedMessage());
  });

  it("calls Claude once and persists a 3-card deck on first invocation", async () => {
    const { cards, cached } = await getOrGenerateDeck("TS1", { db: handle.db });
    expect(callClaudeMock).toHaveBeenCalledTimes(1);
    expect(cached).toBe(false);
    expect(cards).toHaveLength(3);
    expect(cards[0].bloomLevel).toBe(1);
    expect(cards[0].easeFactor).toBeCloseTo(2.5, 10);
    expect(cards[0].intervalDays).toBe(0);

    const rows = handle.db
      .select()
      .from(schema.flashcards)
      .where(eq(schema.flashcards.taskStatementId, "TS1"))
      .all();
    expect(rows).toHaveLength(3);
    handle.close();
  });

  it("caches after first call — second invocation issues zero Claude calls", async () => {
    await getOrGenerateDeck("TS1", { db: handle.db });
    const second = await getOrGenerateDeck("TS1", { db: handle.db });
    expect(callClaudeMock).toHaveBeenCalledTimes(1);
    expect(second.cached).toBe(true);
    expect(second.cards).toHaveLength(3);
    handle.close();
  });

  it("regenerates (appends) when forceRegenerate=true", async () => {
    await getOrGenerateDeck("TS1", { db: handle.db });
    const again = await getOrGenerateDeck("TS1", {
      db: handle.db,
      forceRegenerate: true,
    });
    expect(callClaudeMock).toHaveBeenCalledTimes(2);
    expect(again.cached).toBe(false);
    const total = handle.db
      .select()
      .from(schema.flashcards)
      .where(eq(schema.flashcards.taskStatementId, "TS1"))
      .all();
    expect(total.length).toBe(6); // 3 + 3
    handle.close();
  });

  it("throws not_found on unknown task statement id", async () => {
    await expect(
      getOrGenerateDeck("TS_NOPE", { db: handle.db }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(callClaudeMock).not.toHaveBeenCalled();
    handle.close();
  });

  it("surfaces bad_tool_output when model's schema violates constraints", async () => {
    callClaudeMock.mockResolvedValueOnce({
      ...cannedMessage(),
      content: [
        {
          type: "tool_use",
          id: "tu_bad",
          name: "emit_flashcards",
          input: { cards: [] }, // below minItems 3
        },
      ],
    });
    await expect(
      getOrGenerateDeck("TS1", { db: handle.db }),
    ).rejects.toMatchObject({ code: "bad_tool_output" });
    handle.close();
  });
});

describe("listDueCards / countDueCards", () => {
  let handle: ReturnType<typeof freshDb>;

  beforeEach(() => {
    handle = freshDb();
    seedTs(handle.db);
    callClaudeMock.mockReset();
    callClaudeMock.mockResolvedValue(cannedMessage());
  });

  it("fresh cards (dueAt = now) appear in the due queue", async () => {
    await getOrGenerateDeck("TS1", { db: handle.db });
    const now = new Date();
    const due = listDueCards({ db: handle.db, now });
    expect(due.length).toBe(3);
    expect(countDueCards({ db: handle.db, now })).toBe(3);
    handle.close();
  });

  it("cards with dueAt in the future are excluded", async () => {
    await getOrGenerateDeck("TS1", { db: handle.db });
    const now = new Date(Date.now() - 1 * DAY_MS);
    const due = listDueCards({ db: handle.db, now });
    expect(due.length).toBe(0);
    handle.close();
  });

  it("respects the limit option", async () => {
    await getOrGenerateDeck("TS1", { db: handle.db });
    const due = listDueCards({ db: handle.db, limit: 2 });
    expect(due.length).toBe(2);
    handle.close();
  });
});

describe("applyFlashcardGrade", () => {
  let handle: ReturnType<typeof freshDb>;

  beforeEach(() => {
    handle = freshDb();
    seedTs(handle.db);
    callClaudeMock.mockReset();
    callClaudeMock.mockResolvedValue(cannedMessage());
  });

  it("'good' on a fresh card sets intervalDays=1 and writes a success event (AT3)", async () => {
    const { cards } = await getOrGenerateDeck("TS1", { db: handle.db });
    const card = cards[0];
    const now = new Date("2026-04-13T12:00:00Z");

    const result = applyFlashcardGrade(card.id, "good", {
      db: handle.db,
      now,
    });

    expect(result.intervalDays).toBe(1);
    expect(result.success).toBe(true);
    expect(result.reviewsCount).toBe(1);
    expect(result.dueAt.getTime()).toBe(now.getTime() + DAY_MS);

    const row = handle.db
      .select()
      .from(schema.flashcards)
      .where(eq(schema.flashcards.id, card.id))
      .get();
    expect(row?.intervalDays).toBe(1);
    expect(row?.dueAt.getTime()).toBe(now.getTime() + DAY_MS);
    expect(row?.lastReviewedAt?.getTime()).toBe(now.getTime());

    const events = handle.db
      .select()
      .from(schema.progressEvents)
      .where(eq(schema.progressEvents.taskStatementId, "TS1"))
      .all();
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("flashcard_grade");
    expect(events[0].bloomLevel).toBe(card.bloomLevel);
    expect(events[0].success).toBe(true);
    const payload = events[0].payload as { cardId: string; grade: string };
    expect(payload.cardId).toBe(card.id);
    expect(payload.grade).toBe("good");
    handle.close();
  });

  it("'again' resets interval to 1 day and writes a failure event", async () => {
    const { cards } = await getOrGenerateDeck("TS1", { db: handle.db });
    const card = cards[0];

    // Graduate the card first with good×2 so its interval grows
    applyFlashcardGrade(card.id, "good", {
      db: handle.db,
      now: new Date("2026-04-13T12:00:00Z"),
    });
    applyFlashcardGrade(card.id, "good", {
      db: handle.db,
      now: new Date("2026-04-14T12:00:00Z"),
    });

    const fail = applyFlashcardGrade(card.id, "again", {
      db: handle.db,
      now: new Date("2026-04-20T12:00:00Z"),
    });
    expect(fail.intervalDays).toBe(1);
    expect(fail.success).toBe(false);
    expect(fail.reviewsCount).toBe(3);

    const failEvents = handle.db
      .select()
      .from(schema.progressEvents)
      .all()
      .filter((e) => e.success === false);
    expect(failEvents).toHaveLength(1);
    handle.close();
  });

  it("updates the mastery_snapshots row for (TS, bloomLevel)", async () => {
    const { cards } = await getOrGenerateDeck("TS1", { db: handle.db });
    const l1 = cards.find((c) => c.bloomLevel === 1)!;
    // 5 good grades on the L1 card → snapshot score ≥ 80, itemCount 5
    for (let i = 0; i < 5; i++) {
      applyFlashcardGrade(l1.id, "good", {
        db: handle.db,
        now: new Date(Date.UTC(2026, 3, 13 + i, 12, 0, 0)),
      });
    }
    const snap = handle.db
      .select()
      .from(schema.masterySnapshots)
      .all()
      .find((s) => s.taskStatementId === "TS1" && s.bloomLevel === 1);
    expect(snap).toBeDefined();
    expect(snap!.itemCount).toBe(5);
    expect(snap!.score).toBeGreaterThanOrEqual(80);
    handle.close();
  });

  it("throws not_found on unknown cardId", () => {
    expect(() =>
      applyFlashcardGrade("bogus-id", "good", { db: handle.db }),
    ).toThrow(/not_found|not found/);
    handle.close();
  });

  it("grading one card does not affect another card's SM-2 state", async () => {
    const { cards } = await getOrGenerateDeck("TS1", { db: handle.db });
    const [a, b] = cards;
    applyFlashcardGrade(a.id, "good", { db: handle.db });
    const bRow = handle.db
      .select()
      .from(schema.flashcards)
      .where(eq(schema.flashcards.id, b.id))
      .get();
    expect(bRow?.intervalDays).toBe(0);
    expect(bRow?.reviewsCount).toBe(0);
    handle.close();
  });

  it("grade makes the card due in the future — it drops off listDueCards until then", async () => {
    const { cards } = await getOrGenerateDeck("TS1", { db: handle.db });
    const card = cards[0];
    // Use a 'now' at or after insertion time so the fresh card is due
    const now = new Date(Date.now() + 100);

    expect(listDueCards({ db: handle.db, now }).map((c) => c.id)).toContain(
      card.id,
    );
    applyFlashcardGrade(card.id, "good", { db: handle.db, now });
    expect(listDueCards({ db: handle.db, now }).map((c) => c.id)).not.toContain(
      card.id,
    );
    // But one day later it IS due again
    const later = new Date(now.getTime() + DAY_MS);
    expect(
      listDueCards({ db: handle.db, now: later }).map((c) => c.id),
    ).toContain(card.id);
    handle.close();
  });
});
