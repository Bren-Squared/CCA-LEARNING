import { eq } from "drizzle-orm";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type Db, getAppDb, schema } from "../db";
import {
  type BloomLevel,
  ceilingLevel,
  taskStatementSummary,
} from "../progress/mastery";

/**
 * Phase 18 / E5 — read-only MCP server exposing the curriculum SQLite to
 * Claude Code sessions running in this repo. Two tools, both read-only:
 *
 *   read_curriculum  — task statement / scenario / domain rows + verbatim bullets
 *   read_progress    — per-(TS, Bloom) mastery snapshot rows + recent event count
 *
 * Read-only is enforced by the *absence* of write tools on the server surface,
 * not by the database connection — better-sqlite3 doesn't expose a per-query
 * read-only mode through Drizzle. Documented in `docs/mcp.md`.
 *
 * Resources: each task statement is exposed at `cca://task-statement/{id}` so
 * a Claude Code session can pull verbatim Knowledge/Skills bullets without a
 * tool call. Resources are read-only by spec.
 */

export interface BuildServerOptions {
  db?: Db;
}

export function buildCurriculumServer(opts: BuildServerOptions = {}): McpServer {
  const db = opts.db ?? getAppDb();

  const server = new McpServer({
    name: "cca-curriculum",
    version: "1.0.0",
  });

  // ---------------------------------------------------------------------------
  // Tool: read_curriculum
  // ---------------------------------------------------------------------------
  server.registerTool(
    "read_curriculum",
    {
      title: "Read curriculum row",
      description:
        "Reads ONE row from the CCA curriculum (task statement, scenario, or domain). Pass exactly one of taskStatementId, scenarioId, or domainId. Returns verbatim Knowledge/Skills bullets for task statements and the description text for scenarios. Read-only — never mutates state. Sibling tool: read_progress (for mastery snapshots, not curriculum content).",
      inputSchema: {
        taskStatementId: z
          .string()
          .optional()
          .describe("Task statement id like 'D1.2'"),
        scenarioId: z.string().optional().describe("Scenario id like 'S1'"),
        domainId: z.string().optional().describe("Domain id like 'D1'"),
      },
    },
    async (args) => {
      const filters = [args.taskStatementId, args.scenarioId, args.domainId].filter(
        (v) => typeof v === "string" && v.length > 0,
      );
      if (filters.length !== 1) {
        return toolError(
          "validation",
          "exactly one of taskStatementId / scenarioId / domainId must be provided",
        );
      }
      if (args.taskStatementId) {
        const ts = db
          .select()
          .from(schema.taskStatements)
          .where(eq(schema.taskStatements.id, args.taskStatementId))
          .get();
        if (!ts) return toolError("business", `task statement "${args.taskStatementId}" not found`);
        return jsonResult({
          kind: "task_statement",
          id: ts.id,
          domainId: ts.domainId,
          title: ts.title,
          knowledgeBullets: ts.knowledgeBullets,
          skillsBullets: ts.skillsBullets,
        });
      }
      if (args.scenarioId) {
        const sc = db
          .select()
          .from(schema.scenarios)
          .where(eq(schema.scenarios.id, args.scenarioId))
          .get();
        if (!sc) return toolError("business", `scenario "${args.scenarioId}" not found`);
        const domainMap = db
          .select()
          .from(schema.scenarioDomainMap)
          .where(eq(schema.scenarioDomainMap.scenarioId, sc.id))
          .all();
        return jsonResult({
          kind: "scenario",
          id: sc.id,
          title: sc.title,
          description: sc.description,
          primaryDomainIds: domainMap
            .filter((m) => m.isPrimary)
            .map((m) => m.domainId),
          relatedDomainIds: domainMap
            .filter((m) => !m.isPrimary)
            .map((m) => m.domainId),
        });
      }
      // domainId
      const dom = db
        .select()
        .from(schema.domains)
        .where(eq(schema.domains.id, args.domainId!))
        .get();
      if (!dom) return toolError("business", `domain "${args.domainId}" not found`);
      const tss = db
        .select({ id: schema.taskStatements.id, title: schema.taskStatements.title })
        .from(schema.taskStatements)
        .where(eq(schema.taskStatements.domainId, dom.id))
        .all();
      return jsonResult({
        kind: "domain",
        id: dom.id,
        title: dom.title,
        weightBps: dom.weightBps,
        taskStatements: tss,
      });
    },
  );

  // ---------------------------------------------------------------------------
  // Tool: read_progress
  // ---------------------------------------------------------------------------
  server.registerTool(
    "read_progress",
    {
      title: "Read mastery progress",
      description:
        "Reads the user's mastery snapshot for ONE task statement: per-Bloom-level scores, item counts, current ceiling, and a derived TS summary. Does NOT return raw progress events — those carry payloads we don't surface to Claude Code (privacy minimization). Sibling tool: read_curriculum (for bullet text, not progress data).",
      inputSchema: {
        taskStatementId: z
          .string()
          .describe("Task statement id like 'D1.2'"),
      },
    },
    async ({ taskStatementId }) => {
      const ts = db
        .select()
        .from(schema.taskStatements)
        .where(eq(schema.taskStatements.id, taskStatementId))
        .get();
      if (!ts) {
        return toolError("business", `task statement "${taskStatementId}" not found`);
      }
      const snapshots = db
        .select()
        .from(schema.masterySnapshots)
        .where(eq(schema.masterySnapshots.taskStatementId, taskStatementId))
        .all();
      const levels: Record<number, { score: number; itemCount: number; mastered: boolean }> = {};
      const perLevelForCeiling: Partial<Record<BloomLevel, { score: number; itemCount: number }>> = {};
      for (let i = 1 as BloomLevel; i <= 6; i = (i + 1) as BloomLevel) {
        const snap = snapshots.find((s) => s.bloomLevel === i);
        const score = snap?.score ?? 0;
        const count = snap?.itemCount ?? 0;
        const mastered = score >= 80 && count >= 5;
        levels[i] = { score, itemCount: count, mastered };
        perLevelForCeiling[i] = { score: score / 100, itemCount: count };
      }
      const ceiling = ceilingLevel(perLevelForCeiling);
      const summary = taskStatementSummary({
        1: levels[1].score / 100,
        2: levels[2].score / 100,
        3: levels[3].score / 100,
        4: levels[4].score / 100,
        5: levels[5].score / 100,
        6: levels[6].score / 100,
      });
      return jsonResult({
        kind: "progress",
        taskStatementId: ts.id,
        title: ts.title,
        domainId: ts.domainId,
        levels,
        ceiling,
        summary,
      });
    },
  );

  // ---------------------------------------------------------------------------
  // Resource: each task statement available as cca://task-statement/{id}
  // ---------------------------------------------------------------------------
  // NOTE: registering one resource per TS would yield 30 entries; using a
  // ResourceTemplate keeps the surface compact and lets the client request
  // any TS by id without us pre-listing them.
  // For the simpler v1, register them statically — easier to test, and 30
  // entries is well within MCP list limits.
  const allTs = db
    .select()
    .from(schema.taskStatements)
    .all();
  for (const ts of allTs) {
    server.registerResource(
      `task-statement-${ts.id}`,
      `cca://task-statement/${ts.id}`,
      {
        title: `${ts.id} — ${ts.title}`,
        description: `Verbatim Knowledge & Skills bullets for ${ts.id}.`,
        mimeType: "text/markdown",
      },
      async () => ({
        contents: [
          {
            uri: `cca://task-statement/${ts.id}`,
            mimeType: "text/markdown",
            text: renderTaskStatementMarkdown(ts),
          },
        ],
      }),
    );
  }

  return server;
}

function renderTaskStatementMarkdown(
  ts: typeof schema.taskStatements.$inferSelect,
): string {
  const k = ts.knowledgeBullets.length
    ? ts.knowledgeBullets.map((b, i) => `- (k${i}) ${b}`).join("\n")
    : "_(none)_";
  const s = ts.skillsBullets.length
    ? ts.skillsBullets.map((b, i) => `- (s${i}) ${b}`).join("\n")
    : "_(none)_";
  return `# ${ts.id} — ${ts.title}\n\nDomain: ${ts.domainId}\n\n## Knowledge\n${k}\n\n## Skills\n${s}\n`;
}

function jsonResult(data: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(data, null, 2) },
    ],
  };
}

function toolError(
  category: "validation" | "business" | "permission" | "transient",
  message: string,
) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          isError: true,
          errorCategory: category,
          isRetryable: category === "transient",
          message,
        }),
      },
    ],
  };
}
