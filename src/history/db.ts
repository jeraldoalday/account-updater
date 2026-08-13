import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

/**
 * Opens (creating if needed) the SQLite database backing the evaluation
 * history, and ensures the `evaluations` table exists. `:memory:` is
 * supported as-is (no directory to create) for tests.
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
      reasons TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_evaluations_owner_repo ON evaluations (owner, repo);
  `);

  return db;
}
