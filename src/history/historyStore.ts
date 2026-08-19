import type Database from "better-sqlite3";
import { DEFAULT_PROVIDER_ID, type ProviderId } from "../providers/hosts";
import type { EligibilityResult, RepoRef } from "../types";

export interface EvaluationRecord {
  id: number;
  repo: RepoRef;
  evaluatedAt: string;
  eligible: boolean;
  reasons: string[];
}

interface EvaluationRow {
  id: number;
  provider: string;
  owner: string;
  repo: string;
  evaluated_at: string;
  eligible: number;
  reasons: string;
}

function toRecord(row: EvaluationRow): EvaluationRecord {
  return {
    id: row.id,
    // Rows predating the provider column are backfilled to the default by
    // the migration, so this coalesce only covers a hand-edited database.
    repo: {
      provider: (row.provider ?? DEFAULT_PROVIDER_ID) as ProviderId,
      owner: row.owner,
      repo: row.repo
    },
    evaluatedAt: row.evaluated_at,
    eligible: row.eligible === 1,
    reasons: JSON.parse(row.reasons) as string[]
  };
}

/**
 * Persists a lightweight audit trail of eligibility evaluations to SQLite,
 * so a past result is answerable later rather than only visible as a live
 * snapshot. One row per evaluation actually performed (not per request
 * served — a cache hit doesn't produce a new row).
 */
export class HistoryStore {
  constructor(private db: Database.Database) {}

  record(result: EligibilityResult): void {
    this.db
      .prepare(
        `INSERT INTO evaluations (provider, owner, repo, evaluated_at, eligible, reasons)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        result.repo.provider,
        result.repo.owner,
        result.repo.repo,
        new Date().toISOString(),
        result.eligible ? 1 : 0,
        JSON.stringify(result.reasons)
      );
  }

  /**
   * Cheapest query that still proves the database file is open and the
   * table exists - a readiness probe should fail on a corrupt or missing
   * audit-trail database rather than only discovering it on the first
   * evaluation, where the write is deliberately best-effort.
   */
  ping(): void {
    this.db.prepare(`SELECT id FROM evaluations LIMIT 1`).get();
  }

  listForRepo(ref: RepoRef, limit = 20): EvaluationRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, provider, owner, repo, evaluated_at, eligible, reasons
         FROM evaluations
         WHERE provider = ? AND owner = ? AND repo = ?
         ORDER BY evaluated_at DESC, id DESC
         LIMIT ?`
      )
      .all(ref.provider, ref.owner, ref.repo, limit) as EvaluationRow[];
    return rows.map(toRecord);
  }

  listRecent(limit = 50): EvaluationRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, provider, owner, repo, evaluated_at, eligible, reasons
         FROM evaluations
         ORDER BY evaluated_at DESC, id DESC
         LIMIT ?`
      )
      .all(limit) as EvaluationRow[];
    return rows.map(toRecord);
  }
}
