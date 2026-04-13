import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../lib/db";
import { schema } from "../lib/db";
import { __resetCryptoCacheForTests } from "../lib/settings/crypto";
import {
  clearApiKey,
  getApiKey,
  getSettingsStatus,
  hasApiKey,
  readSettings,
  redactApiKey,
  setApiKey,
  setDefaultModel,
} from "../lib/settings";

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

describe("settings accessors", () => {
  let handle: ReturnType<typeof freshDb>;
  let tmpDir: string;
  let originalOverride: string | undefined;
  let originalEnvKey: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cca-settings-"));
    mkdirSync(tmpDir, { recursive: true });
    originalOverride = process.env.CCA_ENCRYPTION_KEY_PATH;
    process.env.CCA_ENCRYPTION_KEY_PATH = join(tmpDir, ".encryption-key");
    originalEnvKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    __resetCryptoCacheForTests();
    handle = freshDb();
  });

  afterEach(() => {
    handle.close();
    if (originalOverride === undefined) {
      delete process.env.CCA_ENCRYPTION_KEY_PATH;
    } else {
      process.env.CCA_ENCRYPTION_KEY_PATH = originalOverride;
    }
    if (originalEnvKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = originalEnvKey;
    }
    __resetCryptoCacheForTests();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("ensures the singleton settings row lazily on first read", () => {
    const row = readSettings(handle.db);
    expect(row.id).toBe(1);
    expect(row.apiKeyEncrypted).toBeNull();
    expect(row.defaultModel).toBe("claude-sonnet-4-6");
  });

  it("round-trips an API key via setApiKey + getApiKey", () => {
    const key = "sk-ant-api03-" + "c".repeat(64);
    setApiKey(key, handle.db);
    expect(getApiKey(handle.db)).toBe(key);
    expect(hasApiKey(handle.db)).toBe(true);
  });

  it("persists the API key encrypted, not in plaintext", () => {
    const key = "sk-ant-api03-" + "d".repeat(64);
    setApiKey(key, handle.db);
    const row = readSettings(handle.db);
    expect(row.apiKeyEncrypted).toBeTruthy();
    expect(row.apiKeyEncrypted).not.toContain(key);
    expect(row.apiKeyEncrypted!.startsWith("v1:")).toBe(true);
  });

  it("clearApiKey removes the stored ciphertext", () => {
    setApiKey("sk-ant-api03-" + "e".repeat(64), handle.db);
    clearApiKey(handle.db);
    expect(getApiKey(handle.db)).toBeNull();
    expect(hasApiKey(handle.db)).toBe(false);
  });

  it("falls back to ANTHROPIC_API_KEY env when no stored key", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-env-" + "f".repeat(30);
    expect(getApiKey(handle.db)).toBe(process.env.ANTHROPIC_API_KEY);
  });

  it("stored key takes precedence over env", () => {
    const stored = "sk-ant-api03-" + "g".repeat(64);
    setApiKey(stored, handle.db);
    process.env.ANTHROPIC_API_KEY = "sk-ant-env-should-lose";
    expect(getApiKey(handle.db)).toBe(stored);
  });

  it("rejects an implausibly short key", () => {
    expect(() => setApiKey("too-short", handle.db)).toThrow();
  });

  it("getSettingsStatus returns a redacted, browser-safe shape", () => {
    const key = "sk-ant-api03-" + "h".repeat(64);
    setApiKey(key, handle.db);
    const status = getSettingsStatus(handle.db);
    expect(status.apiKeyConfigured).toBe(true);
    expect(status.apiKeyRedacted).not.toBe(key);
    expect(status.apiKeyRedacted!.length).toBeLessThan(key.length);
    expect(JSON.stringify(status)).not.toContain(key);
  });

  it("redactApiKey handles null and short values gracefully", () => {
    expect(redactApiKey(null)).toBeNull();
    expect(redactApiKey("abc")).toBe("***");
    expect(redactApiKey("sk-ant-abcdefghij")).toBe("sk-ant…ghij");
  });

  it("setDefaultModel updates the singleton row", () => {
    setDefaultModel("claude-opus-4-6", handle.db);
    expect(readSettings(handle.db).defaultModel).toBe("claude-opus-4-6");
  });

  it("never writes the raw API key to console during the set/get cycle (NFR3.1)", () => {
    const key = "sk-ant-secret-" + "x".repeat(40);
    const logs: string[] = [];
    const spies = (
      ["log", "warn", "error", "info", "debug"] as const
    ).map((m) =>
      vi.spyOn(console, m).mockImplementation((...args) => {
        logs.push(args.map(String).join(" "));
      }),
    );
    try {
      setApiKey(key, handle.db);
      getSettingsStatus(handle.db);
      getApiKey(handle.db);
      clearApiKey(handle.db);
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
    const joined = logs.join("\n");
    expect(joined).not.toContain(key);
  });
});
