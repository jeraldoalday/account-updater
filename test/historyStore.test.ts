import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { migrateHistoryDb, openHistoryDb } from "../src/history/db";
import { HistoryStore } from "../src/history/historyStore";
import type { EligibilityResult } from "../src/types";

function fakeResult(overrides: Partial<EligibilityResult> = {}): EligibilityResult {
  return {
    eligible: true,
    repo: { provider: "github", owner: "o", repo: "r" },
    checks: {} as EligibilityResult["checks"],
    reasons: ["looks good"],
    ...overrides
  };
}

describe("HistoryStore", () => {
  let store: HistoryStore;

  beforeEach(() => {
    store = new HistoryStore(openHistoryDb(":memory:"));
  });

  it("ping() succeeds on an empty but well-formed database", () => {
    // The readiness probe must not require any evaluation to have happened
    // yet - a freshly deployed instance is ready, not degraded.
    expect(() => store.ping()).not.toThrow();
  });

  it("ping() throws when the evaluations table is missing", () => {
    const emptyDb = new Database(":memory:");
    expect(() => new HistoryStore(emptyDb).ping()).toThrow(/evaluations/);
  });

  it("records an evaluation and lists it back for the repo", () => {
    store.record(fakeResult({ repo: { provider: "github", owner: "acme", repo: "widgets" } }));

    const records = store.listForRepo({ provider: "github", owner: "acme", repo: "widgets" });
    expect(records).toHaveLength(1);
    expect(records[0].eligible).toBe(true);
    expect(records[0].reasons).toEqual(["looks good"]);
    expect(records[0].repo).toEqual({ provider: "github", owner: "acme", repo: "widgets" });
    expect(typeof records[0].evaluatedAt).toBe("string");
  });

  it("scopes listForRepo to the given owner/repo only", () => {
    store.record(fakeResult({ repo: { provider: "github", owner: "acme", repo: "widgets" } }));
    store.record(fakeResult({ repo: { provider: "github", owner: "acme", repo: "gadgets" } }));

    expect(store.listForRepo({ provider: "github", owner: "acme", repo: "widgets" })).toHaveLength(
      1
    );
    expect(store.listForRepo({ provider: "github", owner: "other", repo: "widgets" })).toHaveLength(
      0
    );
  });

  it("orders listForRepo results newest first", () => {
    store.record(fakeResult({ eligible: false, reasons: ["first"] }));
    store.record(fakeResult({ eligible: true, reasons: ["second"] }));

    const records = store.listForRepo({ provider: "github", owner: "o", repo: "r" });
    expect(records.map((r) => r.reasons)).toEqual([["second"], ["first"]]);
  });

  it("listRecent returns evaluations across all repos, newest first, up to the limit", () => {
    store.record(fakeResult({ repo: { provider: "github", owner: "a", repo: "one" } }));
    store.record(fakeResult({ repo: { provider: "github", owner: "b", repo: "two" } }));
    store.record(fakeResult({ repo: { provider: "github", owner: "c", repo: "three" } }));

    const records = store.listRecent(2);
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.repo)).toEqual([
      { provider: "github", owner: "c", repo: "three" },
      { provider: "github", owner: "b", repo: "two" }
    ]);
  });

  it("scopes listForRepo to the ref's provider, not just its owner/repo", () => {
    // The same owner/repo name can exist on two forges and mean two
    // different projects, so the audit trail must not conflate them.
    store.record(fakeResult({ repo: { provider: "github", owner: "acme", repo: "widgets" } }));
    store.record(fakeResult({ repo: { provider: "gitlab", owner: "acme", repo: "widgets" } }));

    const github = store.listForRepo({ provider: "github", owner: "acme", repo: "widgets" });
    const gitlab = store.listForRepo({ provider: "gitlab", owner: "acme", repo: "widgets" });

    expect(github).toHaveLength(1);
    expect(gitlab).toHaveLength(1);
    expect(github[0].repo.provider).toBe("github");
    expect(gitlab[0].repo.provider).toBe("gitlab");
  });

  it("records the provider alongside the owner/repo", () => {
    store.record(fakeResult({ repo: { provider: "github", owner: "acme", repo: "widgets" } }));
    expect(store.listRecent()[0].repo.provider).toBe("github");
  });
});

describe("openHistoryDb migrations", () => {
  it("adds the provider column to a database created before it existed", () => {
    // Simulates an already-deployed history.db: the pre-provider schema,
    // with a row in it, must survive the upgrade rather than needing the
    // audit trail to be dropped and recreated.
    const legacy = new Database(":memory:");
    legacy.exec(`
      CREATE TABLE evaluations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner TEXT NOT NULL,
        repo TEXT NOT NULL,
        evaluated_at TEXT NOT NULL,
        eligible INTEGER NOT NULL,
        reasons TEXT NOT NULL
      );
    `);
    legacy
      .prepare(
        `INSERT INTO evaluations (owner, repo, evaluated_at, eligible, reasons)
         VALUES ('acme', 'widgets', '2026-01-01T00:00:00.000Z', 1, '[]')`
      )
      .run();

    migrateHistoryDb(legacy);

    const store = new HistoryStore(legacy);
    const records = store.listForRepo({ provider: "github", owner: "acme", repo: "widgets" });
    expect(records).toHaveLength(1);
    // Pre-migration rows were necessarily GitHub evaluations, so the
    // backfill is accurate rather than a guess.
    expect(records[0].repo.provider).toBe("github");
  });

  it("is a no-op when run against an already-migrated database", () => {
    const db = openHistoryDb(":memory:");
    expect(() => migrateHistoryDb(db)).not.toThrow();
  });
});
