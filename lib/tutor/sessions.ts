import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import type { Db } from "../db";
import { getAppDb, schema } from "../db";
import { runTutorTurn, type TutorMessage } from "./loop";

/**
 * Tutor session persistence (Phase 9b). Each session is one long-running chat
 * anchored to a single task_statement_id (topic). Messages array is the full
 * Claude-SDK transcript — every user turn, assistant turn (including tool_use
 * blocks), and the user tool_result carrier turns. Resuming a session is just
 * reading the row and handing the messages into {@link runTutorTurn} as
 * `priorMessages`.
 *
 * Sessions are immutable in terms of `topicId` but their `messages` array
 * grows monotonically. `updatedAt` advances on every write so the UI can sort.
 */

export class TutorSessionError extends Error {
  readonly code: "not_found";
  constructor(code: "not_found", message: string) {
    super(message);
    this.code = code;
    this.name = "TutorSessionError";
  }
}

export interface TutorSessionRow {
  id: string;
  topicId: string;
  messages: TutorMessage[];
  createdAt: Date;
  updatedAt: Date;
  messageCount: number;
}

function rowToSession(
  row: typeof schema.tutorSessions.$inferSelect,
): TutorSessionRow {
  const messages = row.messages as unknown as TutorMessage[];
  return {
    id: row.id,
    topicId: row.topicId,
    messages,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    messageCount: messages.length,
  };
}

/**
 * Create a new tutor session pinned to a task statement. Messages starts
 * empty — the first call to {@link sendTutorTurn} fills it.
 */
export function startTutorSession(
  topicId: string,
  db: Db = getAppDb(),
): TutorSessionRow {
  const ts = db
    .select({ id: schema.taskStatements.id })
    .from(schema.taskStatements)
    .where(eq(schema.taskStatements.id, topicId))
    .get();
  if (!ts) {
    throw new TutorSessionError(
      "not_found",
      `task statement "${topicId}" does not exist`,
    );
  }
  const id = randomUUID();
  const now = new Date();
  db.insert(schema.tutorSessions)
    .values({
      id,
      topicId,
      messages: [],
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return {
    id,
    topicId,
    messages: [],
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
  };
}

export function getTutorSession(
  sessionId: string,
  db: Db = getAppDb(),
): TutorSessionRow {
  const row = db
    .select()
    .from(schema.tutorSessions)
    .where(eq(schema.tutorSessions.id, sessionId))
    .get();
  if (!row) {
    throw new TutorSessionError(
      "not_found",
      `tutor session "${sessionId}" not found`,
    );
  }
  return rowToSession(row);
}

export function listTutorSessions(
  db: Db = getAppDb(),
  opts: { topicId?: string; limit?: number } = {},
): TutorSessionRow[] {
  const query = db.select().from(schema.tutorSessions);
  const rows = opts.topicId
    ? query
        .where(eq(schema.tutorSessions.topicId, opts.topicId))
        .orderBy(desc(schema.tutorSessions.updatedAt))
        .limit(opts.limit ?? 50)
        .all()
    : query
        .orderBy(desc(schema.tutorSessions.updatedAt))
        .limit(opts.limit ?? 50)
        .all();
  return rows.map(rowToSession);
}

/**
 * Drive one user turn through the agentic loop and persist the updated
 * transcript. Returns the run result plus the updated session row.
 */
export async function sendTutorTurn(
  sessionId: string,
  userMessage: string,
  opts: { db?: Db; maxIterations?: number; now?: number } = {},
): Promise<{
  session: TutorSessionRow;
  result: Awaited<ReturnType<typeof runTutorTurn>>;
}> {
  const db = opts.db ?? getAppDb();
  const session = getTutorSession(sessionId, db);

  const result = await runTutorTurn({
    topicId: session.topicId,
    priorMessages: session.messages,
    userMessage,
    db,
    maxIterations: opts.maxIterations,
    now: opts.now,
  });

  const now = new Date(opts.now ?? Date.now());
  db.update(schema.tutorSessions)
    .set({
      messages: result.messages,
      updatedAt: now,
    })
    .where(eq(schema.tutorSessions.id, sessionId))
    .run();

  return {
    session: {
      ...session,
      messages: result.messages,
      messageCount: result.messages.length,
      updatedAt: now,
    },
    result,
  };
}

/**
 * Delete a session. Idempotent — returns `{ deleted: boolean }`.
 */
export function deleteTutorSession(
  sessionId: string,
  db: Db = getAppDb(),
): { deleted: boolean } {
  const row = db
    .select({ id: schema.tutorSessions.id })
    .from(schema.tutorSessions)
    .where(eq(schema.tutorSessions.id, sessionId))
    .get();
  if (!row) return { deleted: false };
  db.delete(schema.tutorSessions)
    .where(eq(schema.tutorSessions.id, sessionId))
    .run();
  return { deleted: true };
}
