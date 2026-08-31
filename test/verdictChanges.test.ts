import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { openHistoryDb } from "../src/history/db";
import { HistoryStore } from "../src/history/historyStore";

const listedStore = { verdictChanges: vi.fn(), list: vi.fn(), record: vi.fn() };

vi.mock("../src/history/createHistoryStore", () => ({
  createHistoryStore: () => listedStore
}));

/**
 * Inserts an evaluation at a chosen time. record() always stamps "now",
 * and every question here is about the order verdicts arrived in.
 */
function evaluatedAt(
  store: HistoryStore,
  when: string,
  repo: string,
  eligible: boolean,
  reasons: string[] = [],
  provider = "github"
): void {
  const db = (store as unknown as { db: Database.Database }).db;
  db.prepare(
    `INSERT INTO evaluations (provider, owner, repo, evaluated_at, eligible, reasons)
     VALUES (?, 'acme', ?, ?, ?, ?)`
  ).run(provider, repo, when, eligible ? 1 : 0, JSON.stringify(reasons));
}

describe("HistoryStore.verdictChanges", () => {
  let store: HistoryStore;

  beforeEach(() => {
    store = new HistoryStore(openHistoryDb(":memory:"));
  });

  it("finds nothing in an empty trail", () => {
    expect(store.verdictChanges()).toEqual([]);
  });

  // The first evaluation of a repo has nothing before it to differ from,
  // so it is a starting point rather than a change.
  it("does not call a repo's first evaluation a change", () => {
    evaluatedAt(store, "2026-08-01T00:00:00.000Z", "widgets", false);

    expect(store.verdictChanges()).toEqual([]);
  });

  it("says nothing about a repo that keeps getting the same answer", () => {
    evaluatedAt(store, "2026-08-01T00:00:00.000Z", "widgets", false);
    evaluatedAt(store, "2026-08-02T00:00:00.000Z", "widgets", false);
    evaluatedAt(store, "2026-08-03T00:00:00.000Z", "widgets", false);

    expect(store.verdictChanges()).toEqual([]);
  });

  it("reports a repo that started passing, and when it had last failed", () => {
    evaluatedAt(store, "2026-08-01T00:00:00.000Z", "widgets", false, ["Only 12 commits found."]);
    evaluatedAt(store, "2026-08-05T00:00:00.000Z", "widgets", true);

    expect(store.verdictChanges()).toEqual([
      {
        repo: { provider: "github", owner: "acme", repo: "widgets" },
        direction: "became-eligible",
        changedAt: "2026-08-05T00:00:00.000Z",
        previousEvaluatedAt: "2026-08-01T00:00:00.000Z",
        reasons: []
      }
    ]);
  });

  it("reports a repo that started failing, with the reasons it failed on", () => {
    evaluatedAt(store, "2026-08-01T00:00:00.000Z", "widgets", true);
    evaluatedAt(store, "2026-08-05T00:00:00.000Z", "widgets", false, ["Only 12 commits found."]);

    expect(store.verdictChanges()[0]).toMatchObject({
      direction: "became-ineligible",
      reasons: ["Only 12 commits found."]
    });
  });

  it("reports every flip, not only the most recent one", () => {
    evaluatedAt(store, "2026-08-01T00:00:00.000Z", "widgets", false);
    evaluatedAt(store, "2026-08-02T00:00:00.000Z", "widgets", true);
    evaluatedAt(store, "2026-08-03T00:00:00.000Z", "widgets", false);
    evaluatedAt(store, "2026-08-04T00:00:00.000Z", "widgets", true);

    expect(store.verdictChanges().map((c) => c.direction)).toEqual([
      "became-eligible",
      "became-ineligible",
      "became-eligible"
    ]);
  });

  it("lists changes newest first", () => {
    evaluatedAt(store, "2026-08-01T00:00:00.000Z", "widgets", false);
    evaluatedAt(store, "2026-08-02T00:00:00.000Z", "widgets", true);
    evaluatedAt(store, "2026-08-03T00:00:00.000Z", "gadgets", false);
    evaluatedAt(store, "2026-08-04T00:00:00.000Z", "gadgets", true);

    expect(store.verdictChanges().map((c) => c.changedAt)).toEqual([
      "2026-08-04T00:00:00.000Z",
      "2026-08-02T00:00:00.000Z"
    ]);
  });

  // The comparison has to be against the same repo's previous verdict.
  // Against the previous row overall, two interleaved repos would report a
  // change on nearly every evaluation.
  it("compares a repo against its own history, not the row before it", () => {
    evaluatedAt(store, "2026-08-01T00:00:00.000Z", "widgets", true);
    evaluatedAt(store, "2026-08-01T01:00:00.000Z", "gadgets", false);
    evaluatedAt(store, "2026-08-02T00:00:00.000Z", "widgets", true);
    evaluatedAt(store, "2026-08-02T01:00:00.000Z", "gadgets", false);

    expect(store.verdictChanges()).toEqual([]);
  });

  // "acme/widgets" on two forges are two different projects, the same way
  // they are for the cache key and every other query here.
  it("keeps the same name on two forges apart", () => {
    evaluatedAt(store, "2026-08-01T00:00:00.000Z", "widgets", true, [], "github");
    evaluatedAt(store, "2026-08-02T00:00:00.000Z", "widgets", false, [], "gitlab");

    expect(store.verdictChanges()).toEqual([]);
  });

  it("restricts to one repo when asked", () => {
    evaluatedAt(store, "2026-08-01T00:00:00.000Z", "widgets", false);
    evaluatedAt(store, "2026-08-02T00:00:00.000Z", "widgets", true);
    evaluatedAt(store, "2026-08-01T00:00:00.000Z", "gadgets", false);
    evaluatedAt(store, "2026-08-02T00:00:00.000Z", "gadgets", true);

    const changes = store.verdictChanges({
      ref: { provider: "github", owner: "acme", repo: "widgets" }
    });

    expect(changes).toHaveLength(1);
    expect(changes[0].repo.repo).toBe("widgets");
  });

  it("restricts to one direction when asked", () => {
    evaluatedAt(store, "2026-08-01T00:00:00.000Z", "widgets", false);
    evaluatedAt(store, "2026-08-02T00:00:00.000Z", "widgets", true);
    evaluatedAt(store, "2026-08-03T00:00:00.000Z", "widgets", false);

    expect(store.verdictChanges({ direction: "became-ineligible" })).toHaveLength(1);
    expect(store.verdictChanges({ direction: "became-ineligible" })[0].direction).toBe(
      "became-ineligible"
    );
  });

  // Worth pinning down, because it is the surprising part: narrowing the
  // window drops the "before" as well as the "after", so a change whose
  // earlier verdict fell outside it is no longer a change. The
  // alternative - reaching outside the window for a predecessor - would
  // report a change at a time the caller explicitly excluded.
  it("does not reach outside the window for a repo's earlier verdict", () => {
    evaluatedAt(store, "2026-08-01T00:00:00.000Z", "widgets", false);
    evaluatedAt(store, "2026-08-10T00:00:00.000Z", "widgets", true);

    expect(store.verdictChanges({ since: "2026-08-05T00:00:00.000Z" })).toEqual([]);
    expect(store.verdictChanges({ since: "2026-07-01T00:00:00.000Z" })).toHaveLength(1);
  });

  it("honours an upper bound on the window", () => {
    evaluatedAt(store, "2026-08-01T00:00:00.000Z", "widgets", false);
    evaluatedAt(store, "2026-08-10T00:00:00.000Z", "widgets", true);

    expect(store.verdictChanges({ until: "2026-08-05T00:00:00.000Z" })).toEqual([]);
  });

  it("caps how many changes it returns", () => {
    for (let day = 1; day <= 10; day++) {
      const when = `2026-08-${String(day).padStart(2, "0")}T00:00:00.000Z`;
      evaluatedAt(store, when, "widgets", day % 2 === 0);
    }

    expect(store.verdictChanges({ limit: 3 })).toHaveLength(3);
  });

  it("orders same-instant evaluations by insertion, so a flip isn't invented", () => {
    // Two evaluations stamped identically: without the id tiebreak the
    // window function could order them either way and report a change in
    // whichever direction it happened to pick.
    evaluatedAt(store, "2026-08-01T00:00:00.000Z", "widgets", false);
    evaluatedAt(store, "2026-08-01T00:00:00.000Z", "widgets", false);

    expect(store.verdictChanges()).toEqual([]);
  });
});

describe("GET /admin/evaluations/changes", () => {
  beforeEach(() => {
    listedStore.verdictChanges.mockReset().mockReturnValue([]);
  });

  it("answers with the changes the store found", async () => {
    const { createApp } = await import("../src/app");
    listedStore.verdictChanges.mockReturnValue([
      {
        repo: { provider: "github", owner: "acme", repo: "widgets" },
        direction: "became-ineligible",
        changedAt: "2026-08-05T00:00:00.000Z",
        previousEvaluatedAt: "2026-08-01T00:00:00.000Z",
        reasons: ["Only 12 commits found."]
      }
    ]);

    const res = await request(createApp()).get("/admin/evaluations/changes");

    expect(res.status).toBe(200);
    expect(res.body.changes).toHaveLength(1);
    expect(res.body.changes[0].direction).toBe("became-ineligible");
  });

  it("passes the repo, window, and direction filters through", async () => {
    const { createApp } = await import("../src/app");

    await request(createApp()).get("/admin/evaluations/changes").query({
      repo: "acme/widgets",
      direction: "became-eligible",
      since: "2026-08-01T00:00:00.000Z",
      limit: 5
    });

    expect(listedStore.verdictChanges).toHaveBeenCalledWith({
      ref: { provider: "github", owner: "acme", repo: "widgets" },
      direction: "became-eligible",
      since: "2026-08-01T00:00:00.000Z",
      limit: 5
    });
  });

  it("rejects a direction it does not know rather than ignoring it", async () => {
    const { createApp } = await import("../src/app");

    const res = await request(createApp())
      .get("/admin/evaluations/changes")
      .query({ direction: "got-better" });

    expect(res.status).toBe(400);
    expect(listedStore.verdictChanges).not.toHaveBeenCalled();
  });

  it("rejects an unparseable repo rather than filtering on nothing", async () => {
    const { createApp } = await import("../src/app");

    const res = await request(createApp())
      .get("/admin/evaluations/changes")
      .query({ repo: "https://example.test/not/a/forge" });

    expect(res.status).toBe(400);
  });

  it("rejects an unparseable timestamp", async () => {
    const { createApp } = await import("../src/app");

    const res = await request(createApp())
      .get("/admin/evaluations/changes")
      .query({ since: "last tuesday" });

    expect(res.status).toBe(400);
  });
});
