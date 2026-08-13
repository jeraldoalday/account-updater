import type Database from "better-sqlite3";
import { config } from "../config";
import { openHistoryDb } from "./db";
import { HistoryStore } from "./historyStore";

let db: Database.Database | undefined;

function getDb(): Database.Database {
  if (!db) {
    db = openHistoryDb(config.historyDbPath);
  }
  return db;
}

/** Builds a HistoryStore backed by the shared, lazily-opened SQLite connection. */
export function createHistoryStore(): HistoryStore {
  return new HistoryStore(getDb());
}

/** Closes the SQLite connection, if one was opened, during graceful shutdown. */
export function closeHistoryStore(): void {
  if (db) {
    db.close();
    db = undefined;
  }
}
