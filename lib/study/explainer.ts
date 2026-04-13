import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "../db";
import { getAppDb, schema } from "../db";
import { callClaude } from "../claude/client";
import { loadPromptFile } from "../claude/prompts/loader";
import {
  emitExplainerInputSchema,
  emitExplainerTool,
  type EmitExplainerInput,
} from "../claude/roles/explainer";
import { resolve } from "node:path";

export class ExplainerError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "ExplainerError";
  }
}

export interface ExplainerArtifact {
  narrativeMd: string;
  generatedAt: Date;
  checkQuestions: Array<{
    id: string;
    stem: string;
    options: string[];
    correctIndex: number;
    explanation: string;
    bloomLevel: number;
  }>;
  cached: boolean;
}

function formatBullets(bullets: string[]): string {
  return bullets.map((b) => `- ${b}`).join("\n");
}

function readCached(
  taskStatementId: string,
  db: Db,
): ExplainerArtifact | null {
  const ts = db
    .select()
    .from(schema.taskStatements)
    .where(eq(schema.taskStatements.id, taskStatementId))
    .get();
  if (!ts) throw new ExplainerError("not_found", `task statement "${taskStatementId}" not found`);
  if (!ts.narrativeMd || !ts.narrativeGeneratedAt) return null;

  const questions = db
    .select()
    .from(schema.questions)
    .where(eq(schema.questions.taskStatementId, taskStatementId))
    .all()
    .filter((q) => q.source === "generated" && q.status === "active");

  return {
    narrativeMd: ts.narrativeMd,
    generatedAt: ts.narrativeGeneratedAt,
    checkQuestions: questions.slice(0, 3).map((q) => ({
      id: q.id,
      stem: q.stem,
      options: q.options,
      correctIndex: q.correctIndex,
      explanation: q.explanations[q.correctIndex] ?? q.explanations[0] ?? "",
      bloomLevel: q.bloomLevel,
    })),
    cached: true,
  };
}

function extractToolInput(
  message: Awaited<ReturnType<typeof callClaude>>,
): EmitExplainerInput {
  for (const block of message.content) {
    if (block.type === "tool_use" && block.name === emitExplainerTool.name) {
      const parsed = emitExplainerInputSchema.safeParse(block.input);
      if (!parsed.success) {
        throw new ExplainerError(
          "bad_tool_output",
          `model returned invalid emit_explainer payload: ${parsed.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; ")}`,
        );
      }
      return parsed.data;
    }
  }
  throw new ExplainerError(
    "no_tool_use",
    `model did not call emit_explainer (stop_reason=${message.stop_reason})`,
  );
}

function persistArtifact(
  taskStatementId: string,
  artifact: EmitExplainerInput,
  db: Db,
): ExplainerArtifact {
  const now = new Date();

  return db.transaction((tx) => {
    tx.update(schema.taskStatements)
      .set({
        narrativeMd: artifact.narrative_md,
        narrativeGeneratedAt: now,
      })
      .where(eq(schema.taskStatements.id, taskStatementId))
      .run();

    const inserted: ExplainerArtifact["checkQuestions"] = [];
    for (const q of artifact.check_questions) {
      const id = randomUUID();
      const explanations: string[] = new Array(4).fill("");
      explanations[q.correct_index] = q.explanation;
      tx.insert(schema.questions)
        .values({
          id,
          stem: q.stem,
          options: q.options,
          correctIndex: q.correct_index,
          explanations,
          taskStatementId,
          difficulty: Math.max(1, Math.min(5, q.bloom_level)),
          bloomLevel: q.bloom_level,
          bloomJustification: q.bloom_justification,
          source: "generated",
          status: "active",
        })
        .run();
      inserted.push({
        id,
        stem: q.stem,
        options: q.options,
        correctIndex: q.correct_index,
        explanation: q.explanation,
        bloomLevel: q.bloom_level,
      });
    }

    return {
      narrativeMd: artifact.narrative_md,
      generatedAt: now,
      checkQuestions: inserted,
      cached: false,
    };
  });
}

/**
 * Return the explainer artifact for a task statement. First call generates via
 * Claude and persists; subsequent calls hit the cache only (zero Claude spend,
 * AT11). Pass `forceRegenerate` to invalidate the cache.
 */
export async function getOrGenerateExplainer(
  taskStatementId: string,
  opts: { db?: Db; forceRegenerate?: boolean } = {},
): Promise<ExplainerArtifact> {
  const db = opts.db ?? getAppDb();

  if (!opts.forceRegenerate) {
    const cached = readCached(taskStatementId, db);
    if (cached) return cached;
  }

  const ts = db
    .select()
    .from(schema.taskStatements)
    .where(eq(schema.taskStatements.id, taskStatementId))
    .get();
  if (!ts) {
    throw new ExplainerError(
      "not_found",
      `task statement "${taskStatementId}" not found`,
    );
  }

  const promptPath = resolve(process.cwd(), "prompts/explainer.md");
  const template = loadPromptFile(promptPath);
  const systemPrompt = template.render({
    title: ts.title,
    knowledge_bullets: formatBullets(ts.knowledgeBullets),
    skills_bullets: formatBullets(ts.skillsBullets),
  });

  const message = await callClaude({
    role: "explainer",
    system: systemPrompt,
    cacheSystem: true,
    messages: [
      {
        role: "user",
        content: `Write the narrative + check questions for task statement ${ts.id}: "${ts.title}".`,
      },
    ],
    tools: [
      {
        name: emitExplainerTool.name,
        description: emitExplainerTool.description,
        input_schema: emitExplainerTool.inputSchema,
      },
    ],
    toolChoice: { type: "tool", name: emitExplainerTool.name },
    maxTokens: 4096,
    temperature: 0.3,
    db,
  });

  const input = extractToolInput(message);
  return persistArtifact(taskStatementId, input, db);
}

/**
 * Read-only cache accessor — returns null if not yet generated. Exposed so
 * the detail page can SSR cached content without triggering a generation.
 */
export function readExplainerCache(
  taskStatementId: string,
  db: Db = getAppDb(),
): ExplainerArtifact | null {
  return readCached(taskStatementId, db);
}
