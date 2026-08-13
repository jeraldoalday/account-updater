import { beforeEach, describe, expect, it } from "vitest";
import { openHistoryDb } from "../src/history/db";
import { HistoryStore } from "../src/history/historyStore";
import type { EligibilityResult } from "../src/types";

function fakeResult(overrides: Partial<EligibilityResult> = {}): EligibilityResult {
  return {
    eligible: true,
    repo: { owner: "o", repo: "r" },
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

  it("records an evaluation and lists it back for the repo", () => {
    store.record(fakeResult({ repo: { owner: "acme", repo: "widgets" } }));

    const records = store.listForRepo({ owner: "acme", repo: "widgets" });
    expect(records).toHaveLength(1);
    expect(records[0].eligible).toBe(true);
    expect(records[0].reasons).toEqual(["looks good"]);
    expect(records[0].repo).toEqual({ owner: "acme", repo: "widgets" });
    expect(typeof records[0].evaluatedAt).toBe("string");
  });

  it("scopes listForRepo to the given owner/repo only", () => {
    store.record(fakeResult({ repo: { owner: "acme", repo: "widgets" } }));
    store.record(fakeResult({ repo: { owner: "acme", repo: "gadgets" } }));

    expect(store.listForRepo({ owner: "acme", repo: "widgets" })).toHaveLength(1);
    expect(store.listForRepo({ owner: "other", repo: "widgets" })).toHaveLength(0);
  });

  it("orders listForRepo results newest first", () => {
    store.record(fakeResult({ eligible: false, reasons: ["first"] }));
    store.record(fakeResult({ eligible: true, reasons: ["second"] }));

    const records = store.listForRepo({ owner: "o", repo: "r" });
    expect(records.map((r) => r.reasons)).toEqual([["second"], ["first"]]);
  });

  it("listRecent returns evaluations across all repos, newest first, up to the limit", () => {
    store.record(fakeResult({ repo: { owner: "a", repo: "one" } }));
    store.record(fakeResult({ repo: { owner: "b", repo: "two" } }));
    store.record(fakeResult({ repo: { owner: "c", repo: "three" } }));

    const records = store.listRecent(2);
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.repo)).toEqual([
      { owner: "c", repo: "three" },
      { owner: "b", repo: "two" }
    ]);
  });
});
