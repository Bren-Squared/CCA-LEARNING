import { eq } from "drizzle-orm";
import { type Db, getDb, schema } from "../db";
import { decryptSecret, encryptSecret } from "./crypto";

const SINGLETON_ID = 1;

function ensureRow(db: Db): void {
  const existing = db
    .select({ id: schema.settings.id })
    .from(schema.settings)
    .where(eq(schema.settings.id, SINGLETON_ID))
    .get();
  if (!existing) {
    db.insert(schema.settings).values({ id: SINGLETON_ID }).run();
  }
}

export function readSettings(db: Db = getDb()): schema.Settings {
  ensureRow(db);
  return db
    .select()
    .from(schema.settings)
    .where(eq(schema.settings.id, SINGLETON_ID))
    .get() as schema.Settings;
}

export function setApiKey(key: string, db: Db = getDb()): void {
  if (!key || key.trim().length < 20) {
    throw new Error("API key is missing or implausibly short");
  }
  ensureRow(db);
  const encrypted = encryptSecret(key.trim());
  db.update(schema.settings)
    .set({ apiKeyEncrypted: encrypted })
    .where(eq(schema.settings.id, SINGLETON_ID))
    .run();
}

export function clearApiKey(db: Db = getDb()): void {
  ensureRow(db);
  db.update(schema.settings)
    .set({ apiKeyEncrypted: null })
    .where(eq(schema.settings.id, SINGLETON_ID))
    .run();
}

/**
 * Precedence: DB settings first, then process.env.ANTHROPIC_API_KEY as a
 * Phase-1 fallback for the ingest script. Never log or return this value.
 */
export function getApiKey(db: Db = getDb()): string | null {
  const row = readSettings(db);
  if (row.apiKeyEncrypted) {
    try {
      return decryptSecret(row.apiKeyEncrypted);
    } catch {
      return null;
    }
  }
  const envKey = process.env.ANTHROPIC_API_KEY;
  return envKey && envKey.trim().length > 0 ? envKey.trim() : null;
}

export function hasApiKey(db: Db = getDb()): boolean {
  return getApiKey(db) !== null;
}

export function redactApiKey(key: string | null): string | null {
  if (!key) return null;
  if (key.length <= 8) return "***";
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

export function setDefaultModel(model: string, db: Db = getDb()): void {
  if (!model || model.trim().length === 0) {
    throw new Error("default model cannot be empty");
  }
  ensureRow(db);
  db.update(schema.settings)
    .set({ defaultModel: model.trim() })
    .where(eq(schema.settings.id, SINGLETON_ID))
    .run();
}

export function getDefaultModel(db: Db = getDb()): string {
  return readSettings(db).defaultModel;
}

export function getCheapModel(db: Db = getDb()): string {
  return readSettings(db).cheapModel;
}

/**
 * Status shape safe to send to the browser. Never includes the key itself.
 */
export type SettingsStatus = {
  apiKeyConfigured: boolean;
  apiKeyRedacted: string | null;
  defaultModel: string;
  cheapModel: string;
  tokenBudgetMonthUsd: number;
  bulkCostCeilingUsd: number;
  reviewHalfLifeDays: number;
};

export function getSettingsStatus(db: Db = getDb()): SettingsStatus {
  const row = readSettings(db);
  const key = getApiKey(db);
  return {
    apiKeyConfigured: key !== null,
    apiKeyRedacted: redactApiKey(key),
    defaultModel: row.defaultModel,
    cheapModel: row.cheapModel,
    tokenBudgetMonthUsd: row.tokenBudgetMonthUsd,
    bulkCostCeilingUsd: row.bulkCostCeilingUsd,
    reviewHalfLifeDays: row.reviewHalfLifeDays,
  };
}
