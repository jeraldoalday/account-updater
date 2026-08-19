import type Database from "better-sqlite3";
import { DEFAULT_PROVIDER_ID, type ProviderId } from "../providers/hosts";
import type { EligibilityResult, RepoRef } from "../types";

const DEFAULT_LIMIT = 50;

export interface EvaluationQuery {
  /** Restrict to one repo, scoped to its provider as well as owner/name. */
  ref?: RepoRef;
  /** Restrict to evaluations that passed (true) or failed (false). */
  eligible?: boolean;
  /** Inclusive lower/upper bounds on when the evaluation happened. */
  since?: string;
  until?: string;
  limit?: number;
}

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

/**
 * Rows store `new Date().toISOString()`, so a bound has to be in that same
 * UTC form before it can be compared as text. Throws on an unparseable
 * value rather than silently matching nothing.
 */
function normalizeTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid timestamp: "${value}"`);
  }
  return date.toISOString();
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

  /**
   * Reads the audit trail back, newest first.
   *
   * One method with optional filters rather than a list-per-question:
   * the useful questions combine ("did this repo fail in the last week?"),
   * and every added filter would otherwise mean another near-identical
   * query and another route branch.
   */
  list(query: EvaluationQuery = {}): EvaluationRecord[] {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (query.ref) {
      clauses.push("provider = ? AND owner = ? AND repo = ?");
      params.push(query.ref.provider, query.ref.owner, query.ref.repo);
    }
    if (query.eligible !== undefined) {
      clauses.push("eligible = ?");
      params.push(query.eligible ? 1 : 0);
    }
    // Timestamps are stored as ISO-8601 UTC strings, where lexicographic
    // and chronological order coincide - but only for that exact format,
    // so a caller's "2026-08-01T00:00:00+02:00" is normalized rather than
    // compared as text against a different offset's digits.
    if (query.since !== undefined) {
      clauses.push("evaluated_at >= ?");
      params.push(normalizeTimestamp(query.since));
    }
    if (query.until !== undefined) {
      clauses.push("evaluated_at <= ?");
      params.push(normalizeTimestamp(query.until));
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT id, provider, owner, repo, evaluated_at, eligible, reasons
         FROM evaluations
         ${where}
         ORDER BY evaluated_at DESC, id DESC
         LIMIT ?`
      )
      .all(...params, query.limit ?? DEFAULT_LIMIT) as EvaluationRow[];

    return rows.map(toRecord);
  }
}
