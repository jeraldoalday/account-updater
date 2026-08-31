import type Database from "better-sqlite3";
import { DEFAULT_PROVIDER_ID, type ProviderId } from "../providers/hosts";
import { topFailureReasons, type FailureReasonCount } from "./reasonSummary";
import type { EligibilityResult, RepoRef } from "../types";

const DEFAULT_LIMIT = 50;
const DEFAULT_TOP_N = 5;
// Reason text lives in a JSON column, so grouping it means reading rows
// rather than letting SQLite count them. Bounded, and the response says
// how many rows the tally is based on, so a big window degrades to "the
// most recent N failures" instead of to a slow query.
const REASON_SAMPLE_LIMIT = 2_000;

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

export interface SummaryQuery {
  ref?: RepoRef;
  since?: string;
  until?: string;
  /** How many failure-reason groups to return. Default 5. */
  topN?: number;
}

export interface EvaluationSummary {
  total: number;
  passed: number;
  failed: number;
  /** Share of evaluations that passed, or null when there were none. */
  passRate: number | null;
  distinctRepos: number;
  firstEvaluatedAt?: string;
  lastEvaluatedAt?: string;
  /** How many failed evaluations the reason tally actually read. */
  reasonsSampled: number;
  topFailureReasons: FailureReasonCount[];
}

export type VerdictDirection = "became-eligible" | "became-ineligible";

export interface VerdictChangeQuery {
  ref?: RepoRef;
  since?: string;
  until?: string;
  /** Restrict to changes in one direction. */
  direction?: VerdictDirection;
  limit?: number;
}

export interface VerdictChange {
  repo: RepoRef;
  direction: VerdictDirection;
  /** When the evaluation that changed the verdict ran. */
  changedAt: string;
  /** When the evaluation before it ran, so the old state can be dated. */
  previousEvaluatedAt: string;
  /** The reasons the new verdict came with. Empty for one that passed. */
  reasons: string[];
}

interface VerdictChangeRow {
  provider: string;
  owner: string;
  repo: string;
  evaluated_at: string;
  previous_evaluated_at: string;
  eligible: number;
  reasons: string;
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
   * Deletes rows evaluated strictly before `cutoff`, returning how many
   * went. Returns the count so the caller can log a sweep that actually
   * did something, and say nothing on the (usual) sweep that didn't.
   *
   * Every evaluation writes a row and nothing ever removed one, so an
   * instance left running accumulates the audit trail forever - on a
   * busy deployment the database outgrows the disk it sits on, and the
   * oldest rows it is holding onto are the ones nobody will ever ask
   * about.
   */
  prune(cutoff: string): number {
    const result = this.db
      .prepare(`DELETE FROM evaluations WHERE evaluated_at < ?`)
      .run(normalizeTimestamp(cutoff));
    return result.changes;
  }

  /** The oldest evaluation still stored, or undefined when empty. */
  oldestEvaluatedAt(): string | undefined {
    const row = this.db.prepare(`SELECT MIN(evaluated_at) AS oldest FROM evaluations`).get() as
      { oldest: string | null } | undefined;
    return row?.oldest ?? undefined;
  }

  /**
   * Aggregates the audit trail over a window: how many evaluations, how
   * many passed, across how many repos, and what the failures were about.
   *
   * The per-evaluation list answers "what happened to this repo"; this
   * answers the questions an operator actually opens the trail for -
   * whether the pass rate just moved, and which check is doing the
   * rejecting - without paging through rows to count them by hand.
   */
  summarize(query: SummaryQuery = {}): EvaluationSummary {
    const { where, params } = this.buildFilter(query);

    const totals = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(eligible) AS passed,
                COUNT(DISTINCT provider || '/' || owner || '/' || repo) AS distinctRepos,
                MIN(evaluated_at) AS first,
                MAX(evaluated_at) AS last
         FROM evaluations ${where}`
      )
      .get(...params) as {
      total: number;
      passed: number | null;
      distinctRepos: number;
      first: string | null;
      last: string | null;
    };

    const total = totals.total;
    const passed = totals.passed ?? 0;

    const failureRows = this.db
      .prepare(
        `SELECT reasons FROM evaluations
         ${where ? `${where} AND` : "WHERE"} eligible = 0
         ORDER BY evaluated_at DESC, id DESC
         LIMIT ?`
      )
      .all(...params, REASON_SAMPLE_LIMIT) as { reasons: string }[];

    const reasonLists = failureRows.map((row) => JSON.parse(row.reasons) as string[]);

    return {
      total,
      passed,
      failed: total - passed,
      // Rounded rather than left as a raw ratio, so the value reads as a
      // rate (0.6667) instead of a float artifact (0.6666666666666666).
      passRate: total === 0 ? null : Number((passed / total).toFixed(4)),
      distinctRepos: totals.distinctRepos,
      ...(totals.first ? { firstEvaluatedAt: totals.first } : {}),
      ...(totals.last ? { lastEvaluatedAt: totals.last } : {}),
      reasonsSampled: reasonLists.length,
      topFailureReasons: topFailureReasons(reasonLists, query.topN ?? DEFAULT_TOP_N)
    };
  }

  /**
   * Where a repo's verdict actually flipped, newest first.
   *
   * The row list answers "what happened", and the summary answers "how
   * often" - but the question that gets asked during an incident, or when
   * a threshold has just been retuned, is neither: which repos changed
   * their mind, and which way. Answering that from list() means pulling
   * every row for every repo and diffing them by hand, which is both the
   * slow way and the way that gets it wrong on a repo checked fifty times.
   *
   * A repo's first evaluation inside the window is never a change: there
   * is nothing before it to differ from. That makes the answer depend on
   * `since` in a way worth knowing about - narrowing the window hides
   * changes whose "before" fell outside it - but the alternative, reaching
   * outside the window for a predecessor, would report a change as having
   * happened at a time the caller explicitly excluded.
   */
  verdictChanges(query: VerdictChangeQuery = {}): VerdictChange[] {
    const { where, params } = this.buildFilter(query);

    // LAG over each repo's own evaluations in time order: the comparison
    // has to be against that repo's previous verdict, not the previous
    // row overall, and doing it in SQL keeps the whole window from being
    // read into memory to find the handful of rows that changed.
    const directionClause =
      query.direction === undefined
        ? ""
        : query.direction === "became-eligible"
          ? "AND eligible = 1"
          : "AND eligible = 0";

    const rows = this.db
      .prepare(
        `SELECT provider, owner, repo, evaluated_at, previous_evaluated_at, eligible, reasons
         FROM (
           SELECT provider, owner, repo, evaluated_at, eligible, reasons, id,
                  LAG(eligible) OVER repo_history AS previous_eligible,
                  LAG(evaluated_at) OVER repo_history AS previous_evaluated_at
           FROM evaluations
           ${where}
           WINDOW repo_history AS (
             PARTITION BY provider, owner, repo ORDER BY evaluated_at, id
           )
         )
         WHERE previous_eligible IS NOT NULL
           AND previous_eligible != eligible
           ${directionClause}
         ORDER BY evaluated_at DESC, id DESC
         LIMIT ?`
      )
      .all(...params, query.limit ?? DEFAULT_LIMIT) as VerdictChangeRow[];

    return rows.map((row) => ({
      repo: {
        provider: (row.provider ?? DEFAULT_PROVIDER_ID) as ProviderId,
        owner: row.owner,
        repo: row.repo
      },
      direction: row.eligible === 1 ? "became-eligible" : "became-ineligible",
      changedAt: row.evaluated_at,
      previousEvaluatedAt: row.previous_evaluated_at,
      reasons: JSON.parse(row.reasons) as string[]
    }));
  }

  /**
   * The repo/outcome/window clauses shared by list() and summarize(), so
   * the two can't drift into answering subtly different questions.
   */
  private buildFilter(query: EvaluationQuery): { where: string; params: unknown[] } {
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

    return { where: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "", params };
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
    const { where, params } = this.buildFilter(query);

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
