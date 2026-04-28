import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";
import { callClaude } from "../claude/client";
import { loadPromptFile } from "../claude/prompts/loader";
import {
  emitDedupVerdictInputSchema,
  emitDedupVerdictTool,
  type EmitDedupVerdictInput,
} from "../claude/roles/deduplicator";
import type { Db } from "../db";
import { getAppDb, schema } from "../db";
import { getCheapModel } from "../settings";
import { flagQuestion } from "./coverage";

export interface DedupGroup {
  questionIds: string[];
  keepId: string;
  retireIds: string[];
  reason: string;
}

export interface DedupCellResult {
  taskStatementId: string;
  bloomLevel: number;
  groups: DedupGroup[];
  totalQuestions: number;
  duplicatesFound: number;
}

export interface DedupScanResult {
  cellsAnalyzed: number;
  cellsWithDuplicates: number;
  totalDuplicates: number;
  cells: DedupCellResult[];
}

interface CellQuestions {
  taskStatementId: string;
  taskStatementTitle: string;
  bloomLevel: number;
  questions: Array<{ id: string; stem: string; source: string }>;
}

/**
 * Collect all (task_statement × bloom_level) cells that have 2+ active
 * questions — these are the only cells where duplicates can exist.
 */
function collectCellsToAnalyze(db: Db): CellQuestions[] {
  const rows = db
    .select({
      id: schema.questions.id,
      stem: schema.questions.stem,
      source: schema.questions.source,
      taskStatementId: schema.questions.taskStatementId,
      bloomLevel: schema.questions.bloomLevel,
    })
    .from(schema.questions)
    .where(eq(schema.questions.status, "active"))
    .all();

  const taskStatements = new Map(
    db
      .select({ id: schema.taskStatements.id, title: schema.taskStatements.title })
      .from(schema.taskStatements)
      .all()
      .map((ts) => [ts.id, ts.title]),
  );

  const cellMap = new Map<string, CellQuestions>();
  for (const r of rows) {
    const key = `${r.taskStatementId}|${r.bloomLevel}`;
    let cell = cellMap.get(key);
    if (!cell) {
      cell = {
        taskStatementId: r.taskStatementId,
        taskStatementTitle: taskStatements.get(r.taskStatementId) ?? r.taskStatementId,
        bloomLevel: r.bloomLevel,
        questions: [],
      };
      cellMap.set(key, cell);
    }
    cell.questions.push({ id: r.id, stem: r.stem, source: r.source });
  }

  return Array.from(cellMap.values())
    .filter((c) => c.questions.length >= 2)
    .sort((a, b) =>
      a.taskStatementId.localeCompare(b.taskStatementId) ||
      a.bloomLevel - b.bloomLevel,
    );
}

function formatQuestionsBlock(
  questions: Array<{ id: string; stem: string; source: string }>,
): string {
  const lines = questions.map(
    (q, i) =>
      `${i + 1}. **ID**: \`${q.id}\` (${q.source})\n   **Stem**: ${q.stem}`,
  );
  return `## Questions to analyze (${questions.length} total)\n\n${lines.join("\n\n")}`;
}

async function analyzeCell(
  cell: CellQuestions,
  db: Db,
): Promise<DedupCellResult> {
  const promptPath = resolve(process.cwd(), "prompts/deduplicator.md");
  const template = loadPromptFile(promptPath);
  const systemPrompt = template.render({
    task_statement_id: cell.taskStatementId,
    task_statement_title: cell.taskStatementTitle,
    bloom_level: cell.bloomLevel,
    questions_block: formatQuestionsBlock(cell.questions),
  });

  const message = await callClaude({
    role: "deduplicator",
    model: getCheapModel(db),
    system: systemPrompt,
    cacheSystem: false,
    messages: [
      {
        role: "user",
        content: `Analyze these ${cell.questions.length} questions for duplicates. Emit your verdict via emit_dedup_verdict.`,
      },
    ],
    tools: [
      {
        name: emitDedupVerdictTool.name,
        description: emitDedupVerdictTool.description,
        input_schema: emitDedupVerdictTool.inputSchema,
      },
    ],
    toolChoice: { type: "tool", name: emitDedupVerdictTool.name },
    maxTokens: 1024,
    temperature: 0,
    db,
  });

  const verdict = extractDedupVerdict(message);
  const validIds = new Set(cell.questions.map((q) => q.id));

  // Filter out any groups referencing IDs not in this cell (hallucination guard)
  const groups: DedupGroup[] = verdict.groups
    .filter(
      (g) =>
        g.question_ids.every((id) => validIds.has(id)) &&
        validIds.has(g.keep_id) &&
        g.retire_ids.every((id) => validIds.has(id)),
    )
    .map((g) => ({
      questionIds: g.question_ids,
      keepId: g.keep_id,
      retireIds: g.retire_ids,
      reason: g.reason,
    }));

  const duplicatesFound = groups.reduce((n, g) => n + g.retireIds.length, 0);

  return {
    taskStatementId: cell.taskStatementId,
    bloomLevel: cell.bloomLevel,
    groups,
    totalQuestions: cell.questions.length,
    duplicatesFound,
  };
}

function extractDedupVerdict(message: Anthropic.Message): EmitDedupVerdictInput {
  for (const block of message.content) {
    if (block.type === "tool_use" && block.name === emitDedupVerdictTool.name) {
      const parsed = emitDedupVerdictInputSchema.safeParse(block.input);
      if (parsed.success) return parsed.data;
      // On validation failure, return empty (treat as "all distinct")
      return { groups: [], summary: "analysis failed validation — treating all as distinct" };
    }
  }
  return { groups: [], summary: "no tool call emitted — treating all as distinct" };
}

/**
 * Scan every (task_statement × bloom_level) cell with 2+ active questions
 * for semantic duplicates. Calls Claude (cheap model) once per cell.
 */
export async function scanForDuplicates(
  db: Db = getAppDb(),
): Promise<DedupScanResult> {
  const cells = collectCellsToAnalyze(db);

  const results: DedupCellResult[] = [];
  for (const cell of cells) {
    const result = await analyzeCell(cell, db);
    if (result.groups.length > 0) {
      results.push(result);
    }
  }

  const totalDuplicates = results.reduce(
    (n, r) => n + r.duplicatesFound,
    0,
  );

  return {
    cellsAnalyzed: cells.length,
    cellsWithDuplicates: results.length,
    totalDuplicates,
    cells: results,
  };
}

/**
 * Retire a list of question IDs (batch wrapper around flagQuestion).
 * Returns the count of questions actually retired (excludes already-retired
 * and not-found).
 */
export function retireDuplicates(
  retireIds: string[],
  db: Db = getAppDb(),
): { retired: number } {
  let retired = 0;
  for (const id of retireIds) {
    const result = flagQuestion(id, db);
    if (result.ok && result.previousStatus !== "retired") {
      retired += 1;
    }
  }
  return { retired };
}
