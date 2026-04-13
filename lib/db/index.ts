import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import * as schema from "./schema";

export type Db = ReturnType<typeof drizzle<typeof schema>>;

/**
 * A Db handle OR a transaction scope inside `db.transaction(tx => …)`.
 * Use this when a function may be called either at top level or nested
 * inside an outer transaction.
 */
export type DbClient = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

let _db: Db | null = null;
let _sqlite: Database.Database | null = null;

export function getDb(): Db {
  if (_db) return _db;

  const url = process.env.DATABASE_URL ?? "./data/app.sqlite";
  const filePath = resolve(process.cwd(), url.replace(/^file:/, ""));

  mkdirSync(dirname(filePath), { recursive: true });

  const sqlite = new Database(filePath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");

  _sqlite = sqlite;
  _db = drizzle(sqlite, { schema });
  return _db;
}

export function closeDb(): void {
  _sqlite?.close();
  _sqlite = null;
  _db = null;
}

export function runMigrations(db: Db = getDb()): void {
  migrate(db, { migrationsFolder: resolve(process.cwd(), "drizzle") });
}

let _migrated = false;

/**
 * Returns a migrated handle. Use this from API routes / scripts that need
 * the schema up to date. Idempotent: migrations only run once per process.
 */
export function getAppDb(): Db {
  const db = getDb();
  if (!_migrated) {
    runMigrations(db);
    _migrated = true;
  }
  return db;
}

export { schema };
