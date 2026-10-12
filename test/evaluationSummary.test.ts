import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { openHistoryDb } from "../src/history/db";
import { HistoryStore } from "../src/history/historyStore";
import { normalizeReason, topFailureReasons } from "../src/history/reasonSummary";

const summarize = vi.fn();

// The route reaches for the process-wide store; the store's own behaviour
// is covered directly against SQLite further down.
vi.mock("../src/history/createHistoryStore", () => ({
  createHistoryStore: () => ({
    list: () => [],
    record: vi.fn(),
    summarize: (...args: unknown[]) => summarize(...args)
  })
}));

const { createApp } = await import("../src/app");

function seed(
  store: HistoryStore,
  options: { at: string; repo?: string; owner?: string; eligible?: boolean; reasons?: string[] }
): void {
  const db = (store as unknown as { db: Database.Database }).db;
  db.prepare(
    `INSERT INTO evaluations (provider, owner, repo, evaluated_at, eligible, reasons)
     VALUES ('github', ?, ?, ?, ?, ?)`
  ).run(
    options.owner ?? "acme",
    options.repo ?? "widgets",
    options.at,
    options.eligible === false ? 0 : 1,
    JSON.stringify(options.reasons ?? [])
  );
}

describe("normalizeReason", () => {
  it("replaces the counts that make every repo's failure look unique", () => {
    expect(normalizeReason("Only 12 lines of first-party source found (need at least 500).")).toBe(
      "Only N lines of first-party source found (need at least N)."
    );
  });

  it("folds two repos' versions of the same failure onto one key", () => {
    const a = normalizeReason("Only 12 lines of source found (need at least 500).");
    const b = normalizeReason("Only 340 lines of source found (need at least 500).");
    expect(a).toBe(b);
  });

  it("replaces quoted values, which name the repo's own language", () => {
    expect(normalizeReason('Primary language "Ruby" is not eligible.')).toBe(
      'Primary language "…" is not eligible.'
    );
  });

  it("normalizes percentages and decimals too", () => {
    expect(normalizeReason("Score 0.42 is below 0.6 (73% of commits on one day).")).toBe(
      "Score N is below N (N of commits on one day)."
    );
  });

  it("collapses stray whitespace so formatting differences don't split a group", () => {
    expect(normalizeReason("Too   few\ncommits.")).toBe("Too few commits.");
  });

  it("leaves a reason with no varying parts alone", () => {
    const reason = "No first-party source files were found in an eligible language.";
    expect(normalizeReason(reason)).toBe(reason);
  });
});

describe("topFailureReasons", () => {
  it("counts groups, most common first, keeping a verbatim example", () => {
    const result = topFailureReasons(
      [["Only 10 lines found."], ["Only 20 lines found.", "No commits."], ["Only 30 lines found."]],
      5
    );

    expect(result[0]).toEqual({
      reason: "Only N lines found.",
      count: 3,
      example: "Only 10 lines found."
    });
    expect(result[1]).toEqual({ reason: "No commits.", count: 1, example: "No commits." });
  });

  it("caps the number of groups returned", () => {
    const result = topFailureReasons([["a", "b", "c", "d"]], 2);
    expect(result).toHaveLength(2);
  });

  it("breaks ties alphabetically, so repeated calls agree", () => {
    const result = topFailureReasons([["b reason", "a reason"]], 5);
    expect(result.map((r) => r.reason)).toEqual(["a reason", "b reason"]);
  });

  it("returns nothing when there were no failures", () => {
    expect(topFailureReasons([], 5)).toEqual([]);
  });
});

describe("HistoryStore.summarize", () => {
  let store: HistoryStore;

  beforeEach(() => {
    store = new HistoryStore(openHistoryDb(":memory:"));
  });

  it("counts outcomes, repos, and the window's bounds", () => {
    seed(store, { at: "2026-08-01T00:00:00.000Z", repo: "a" });
    seed(store, {
      at: "2026-08-02T00:00:00.000Z",
      repo: "b",
      eligible: false,
      reasons: ["No commits."]
    });
    seed(store, { at: "2026-08-03T00:00:00.000Z", repo: "a" });

    const summary = store.summarize();

    expect(summary.total).toBe(3);
    expect(summary.passed).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.passRate).toBeCloseTo(0.6667, 4);
    expect(summary.distinctRepos).toBe(2);
    expect(summary.firstEvaluatedAt).toBe("2026-08-01T00:00:00.000Z");
    expect(summary.lastEvaluatedAt).toBe("2026-08-03T00:00:00.000Z");
  });

  it("reports an empty trail without dividing by zero", () => {
    const summary = store.summarize();

    expect(summary).toMatchObject({
      total: 0,
      passed: 0,
      failed: 0,
      passRate: null,
      distinctRepos: 0,
      reasonsSampled: 0,
      topFailureReasons: []
    });
    expect(summary.firstEvaluatedAt).toBeUndefined();
  });

  it("groups failure reasons across repos", () => {
    seed(store, {
      at: "2026-08-01T00:00:00.000Z",
      repo: "a",
      eligible: false,
      reasons: ["Only 12 lines of source found (need at least 500)."]
    });
    seed(store, {
      at: "2026-08-02T00:00:00.000Z",
      repo: "b",
      eligible: false,
      reasons: ["Only 300 lines of source found (need at least 500).", "No commits."]
    });

    const summary = store.summarize();

    expect(summary.reasonsSampled).toBe(2);
    expect(summary.topFailureReasons[0]).toMatchObject({
      reason: "Only N lines of source found (need at least N).",
      count: 2
    });
  });

  it("counts only the window it was asked about", () => {
    seed(store, { at: "2026-07-01T00:00:00.000Z", repo: "old" });
    seed(store, { at: "2026-08-10T00:00:00.000Z", repo: "new", eligible: false });

    const summary = store.summarize({ since: "2026-08-01T00:00:00.000Z" });

    expect(summary.total).toBe(1);
    expect(summary.passed).toBe(0);
  });

  it("counts only the repo it was asked about, scoped to its provider", () => {
    seed(store, { at: "2026-08-01T00:00:00.000Z", repo: "widgets" });
    seed(store, { at: "2026-08-02T00:00:00.000Z", repo: "gadgets", eligible: false });

    const summary = store.summarize({
      ref: { provider: "github", owner: "acme", repo: "widgets" }
    });

    expect(summary.total).toBe(1);
    expect(summary.passed).toBe(1);
    expect(summary.distinctRepos).toBe(1);
  });

  it("honours the requested number of reason groups", () => {
    seed(store, {
      at: "2026-08-01T00:00:00.000Z",
      eligible: false,
      reasons: ["one", "two", "three"]
    });

    expect(store.summarize({ topN: 2 }).topFailureReasons).toHaveLength(2);
  });
});

describe("GET /admin/evaluations/summary", () => {
  beforeEach(() => {
    summarize.mockReset().mockReturnValue({ total: 0, passed: 0, failed: 0, passRate: null });
  });

  it("returns the summary for the whole trail by default", async () => {
    const res = await request(createApp()).get("/admin/evaluations/summary");

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    expect(summarize).toHaveBeenCalledWith({ topN: 5 });
  });

  it("passes the repo, window, and group count through", async () => {
    await request(createApp()).get("/admin/evaluations/summary").query({
      repo: "acme/widgets",
      since: "2026-08-01T00:00:00.000Z",
      until: "2026-08-20T00:00:00.000Z",
      topReasons: "3"
    });

    expect(summarize).toHaveBeenCalledWith({
      ref: { provider: "github", owner: "acme", repo: "widgets" },
      since: "2026-08-01T00:00:00.000Z",
      until: "2026-08-20T00:00:00.000Z",
      topN: 3
    });
  });

  it("rejects an unparseable repo rather than summarizing everything", async () => {
    const res = await request(createApp())
      .get("/admin/evaluations/summary")
      .query({ repo: "not a repo!!" });

    expect(res.status).toBe(400);
    expect(summarize).not.toHaveBeenCalled();
  });

  it("rejects an unparseable window bound", async () => {
    const res = await request(createApp())
      .get("/admin/evaluations/summary")
      .query({ since: "last tuesday" });

    expect(res.status).toBe(400);
  });

  it("rejects a window that closes before it opens, rather than summarizing an empty window", async () => {
    const res = await request(createApp()).get("/admin/evaluations/summary").query({
      since: "2026-08-20T00:00:00.000Z",
      until: "2026-08-01T00:00:00.000Z"
    });

    expect(res.status).toBe(400);
    expect(summarize).not.toHaveBeenCalled();
  });

  it("caps how many reason groups a caller can ask for", async () => {
    const res = await request(createApp())
      .get("/admin/evaluations/summary")
      .query({ topReasons: "500" });

    expect(res.status).toBe(400);
  });
});
