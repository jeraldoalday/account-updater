import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { DEFAULT_PROVIDER_ID } from "../providers/hosts";

interface ColumnRow {
  name: string;
}

/**
 * Adds columns introduced after the table's original shape shipped. SQLite
 * has no "ADD COLUMN IF NOT EXISTS", and an existing deployment's
 * history.db predates these, so check first and migrate in place rather
 * than requiring anyone to drop their audit trail.
 */
export function migrateHistoryDb(db: Database.Database): void {
  const columns = (db.prepare(`PRAGMA table_info(evaluations)`).all() as ColumnRow[]).map(
    (c) => c.name
  );

  if (!columns.includes("provider")) {
    // Every row written before this column existed was a GitHub evaluation
    // - GitHub was the only provider the service could evaluate - so
    // backfilling them with the default is accurate, not a guess.
    db.exec(
      `ALTER TABLE evaluations ADD COLUMN provider TEXT NOT NULL DEFAULT '${DEFAULT_PROVIDER_ID}'`
    );
  }
}

/**
 * Opens (creating if needed) the SQLite database backing the evaluation
 * history, and ensures the `evaluations` table exists and is up to date.
 * `:memory:` is supported as-is (no directory to create) for tests.
 */
export function openHistoryDb(path: string): Database.Database {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new Database(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS evaluations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner TEXT NOT NULL,
      repo TEXT NOT NULL,
      evaluated_at TEXT NOT NULL,
      eligible INTEGER NOT NULL,
      reasons TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT '${DEFAULT_PROVIDER_ID}'
    );
  `);

  migrateHistoryDb(db);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_evaluations_owner_repo ON evaluations (owner, repo);
    CREATE INDEX IF NOT EXISTS idx_evaluations_provider_owner_repo
      ON evaluations (provider, owner, repo);
  `);

  return db;
}
