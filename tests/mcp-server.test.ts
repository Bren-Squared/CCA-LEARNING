import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Db } from "../lib/db";
import { schema } from "../lib/db";
import { buildCurriculumServer } from "../lib/mcp/curriculum-server";

const DRIZZLE_DIR = resolve(process.cwd(), "drizzle");

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

function seedCurriculum(db: Db) {
  db.insert(schema.domains)
    .values({ id: "D1", title: "Agentic Architecture", weightBps: 2700, orderIndex: 1 })
    .run();
  db.insert(schema.taskStatements)
    .values({
      id: "D1.2",
      domainId: "D1",
      title: "Apply the coordinator-subagent pattern",
      knowledgeBullets: ["coordinator orchestrates subagents", "subagents have isolated context"],
      skillsBullets: ["choose subagent boundaries"],
      orderIndex: 2,
    })
    .run();
  db.insert(schema.scenarios)
    .values({
      id: "S1",
      title: "Customer support",
      description: "An agent that routes requests.",
      orderIndex: 1,
    })
    .run();
  db.insert(schema.scenarioDomainMap)
    .values({ scenarioId: "S1", domainId: "D1", isPrimary: true })
    .run();
}

async function connect(db: Db) {
  const server = buildCurriculumServer({ db });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "test-client", version: "1.0.0" },
    { capabilities: {} },
  );
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { client, server };
}

describe("MCP curriculum server (E5 / AT24)", () => {
  let handle: ReturnType<typeof freshDb>;

  beforeEach(() => {
    handle = freshDb();
    seedCurriculum(handle.db);
  });

  afterEach(() => {
    handle.close();
  });

  it("exposes only read-only tools (no write_* in the list)", async () => {
    const { client, server } = await connect(handle.db);
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toContain("read_curriculum");
    expect(names).toContain("read_progress");
    expect(names.filter((n) => n.startsWith("write_"))).toEqual([]);
    expect(names.filter((n) => n.startsWith("update_"))).toEqual([]);
    expect(names.filter((n) => n.startsWith("delete_"))).toEqual([]);
    await server.close();
  });

  it("read_curriculum returns verbatim Knowledge/Skills bullets for a TS", async () => {
    const { client, server } = await connect(handle.db);
    const result = await client.callTool({
      name: "read_curriculum",
      arguments: { taskStatementId: "D1.2" },
    });
    const text = (result.content as Array<{ type: string; text?: string }>)?.[0]?.text;
    expect(text).toBeDefined();
    const parsed = JSON.parse(text!);
    expect(parsed.id).toBe("D1.2");
    expect(parsed.knowledgeBullets).toEqual([
      "coordinator orchestrates subagents",
      "subagents have isolated context",
    ]);
    expect(parsed.skillsBullets).toEqual(["choose subagent boundaries"]);
    await server.close();
  });

  it("read_curriculum returns scenario rows with domain mappings", async () => {
    const { client, server } = await connect(handle.db);
    const result = await client.callTool({
      name: "read_curriculum",
      arguments: { scenarioId: "S1" },
    });
    const text = (result.content as Array<{ type: string; text?: string }>)?.[0]?.text;
    const parsed = JSON.parse(text!);
    expect(parsed.kind).toBe("scenario");
    expect(parsed.primaryDomainIds).toEqual(["D1"]);
    await server.close();
  });

  it("read_curriculum errors on unknown id", async () => {
    const { client, server } = await connect(handle.db);
    const result = await client.callTool({
      name: "read_curriculum",
      arguments: { taskStatementId: "NOPE" },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text?: string }>)?.[0]?.text;
    const parsed = JSON.parse(text!);
    expect(parsed.errorCategory).toBe("business");
    await server.close();
  });

  it("read_curriculum rejects when ZERO or MULTIPLE id args are provided", async () => {
    const { client, server } = await connect(handle.db);
    // Multiple ids
    const r1 = await client.callTool({
      name: "read_curriculum",
      arguments: { taskStatementId: "D1.2", scenarioId: "S1" },
    });
    expect(r1.isError).toBe(true);
    // Zero ids
    const r2 = await client.callTool({
      name: "read_curriculum",
      arguments: {},
    });
    expect(r2.isError).toBe(true);
    await server.close();
  });

  it("read_progress returns six Bloom-level snapshots, even when empty", async () => {
    const { client, server } = await connect(handle.db);
    const result = await client.callTool({
      name: "read_progress",
      arguments: { taskStatementId: "D1.2" },
    });
    const text = (result.content as Array<{ type: string; text?: string }>)?.[0]?.text;
    const parsed = JSON.parse(text!);
    expect(parsed.kind).toBe("progress");
    expect(parsed.taskStatementId).toBe("D1.2");
    expect(Object.keys(parsed.levels)).toEqual(["1", "2", "3", "4", "5", "6"]);
    expect(parsed.ceiling).toBe(0); // nothing graded yet
    await server.close();
  });

  it("read_progress reflects mastery snapshots written via the app", async () => {
    handle.db
      .insert(schema.masterySnapshots)
      .values({
        taskStatementId: "D1.2",
        bloomLevel: 2,
        score: 90,
        itemCount: 6,
        updatedAt: new Date(),
      })
      .run();
    const { client, server } = await connect(handle.db);
    const result = await client.callTool({
      name: "read_progress",
      arguments: { taskStatementId: "D1.2" },
    });
    const text = (result.content as Array<{ type: string; text?: string }>)?.[0]?.text;
    const parsed = JSON.parse(text!);
    expect(parsed.levels["2"].score).toBe(90);
    expect(parsed.levels["2"].mastered).toBe(true);
    expect(parsed.ceiling).toBe(2);
    await server.close();
  });

  it("exposes task-statement resources at cca://task-statement/{id}", async () => {
    const { client, server } = await connect(handle.db);
    const list = await client.listResources();
    const ts = list.resources.find(
      (r) => r.uri === "cca://task-statement/D1.2",
    );
    expect(ts).toBeDefined();
    expect(ts!.mimeType).toBe("text/markdown");

    const read = await client.readResource({ uri: "cca://task-statement/D1.2" });
    const md = (read.contents[0] as { text?: string }).text!;
    expect(md).toMatch(/D1.2/);
    expect(md).toMatch(/coordinator orchestrates subagents/);
    await server.close();
  });
});
