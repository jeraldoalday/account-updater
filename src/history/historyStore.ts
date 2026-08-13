import type Database from "better-sqlite3";
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
  owner: string;
  repo: string;
  evaluated_at: string;
  eligible: number;
  reasons: string;
}

function toRecord(row: EvaluationRow): EvaluationRecord {
  return {
    id: row.id,
    repo: { owner: row.owner, repo: row.repo },
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
        `INSERT INTO evaluations (owner, repo, evaluated_at, eligible, reasons)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        result.repo.owner,
        result.repo.repo,
        new Date().toISOString(),
        result.eligible ? 1 : 0,
        JSON.stringify(result.reasons)
      );
  }

  listForRepo(ref: RepoRef, limit = 20): EvaluationRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, owner, repo, evaluated_at, eligible, reasons
         FROM evaluations
         WHERE owner = ? AND repo = ?
         ORDER BY evaluated_at DESC, id DESC
         LIMIT ?`
      )
      .all(ref.owner, ref.repo, limit) as EvaluationRow[];
    return rows.map(toRecord);
  }

  listRecent(limit = 50): EvaluationRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, owner, repo, evaluated_at, eligible, reasons
         FROM evaluations
         ORDER BY evaluated_at DESC, id DESC
         LIMIT ?`
      )
      .all(limit) as EvaluationRow[];
    return rows.map(toRecord);
  }
}
