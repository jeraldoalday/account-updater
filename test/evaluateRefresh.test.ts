import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { metrics } from "../src/metrics/metrics";

const getCommitHistorySummary = vi.fn();
const getPushEventSummary = vi.fn();
const withShallowClone = vi.fn();
const scanSource = vi.fn();
const cacheGet = vi.fn();
const cacheSet = vi.fn();

// Partial: the app's OpenAPI spec also reads supportedProviderIds() from
// this module at import time.
vi.mock("../src/providers/registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/providers/registry")>()),
  createProvider: () => ({ id: "github", getCommitHistorySummary, getPushEventSummary })
}));

vi.mock("../src/clone/tempClone", () => ({
  withShallowClone: (...args: unknown[]) => withShallowClone(...args)
}));

vi.mock("../src/analysis/sourceScan", () => ({
  scanSource: (...args: unknown[]) => scanSource(...args)
}));

vi.mock("../src/history/createHistoryStore", () => ({
  createHistoryStore: () => ({ record: vi.fn(), list: () => [] })
}));

vi.mock("../src/cache/createCache", () => ({
  createCache: () => ({
    get: (...args: unknown[]) => cacheGet(...args),
    set: (...args: unknown[]) => cacheSet(...args),
    clear: vi.fn()
  })
}));

const { evaluateEligibility } = await import("../src/eligibility/evaluate");
const { createApp } = await import("../src/app");

const ref = { provider: "github" as const, owner: "acme", repo: "widgets" };

const CACHED_RESULT = {
  eligible: false,
  repo: ref,
  checks: {},
  reasons: ["stale answer from the cache"]
};

describe("evaluateEligibility with refresh", () => {
  beforeEach(() => {
    getCommitHistorySummary.mockReset().mockResolvedValue({
      commitCount: 200,
      firstCommitDate: "2026-01-01T00:00:00Z",
      lastCommitDate: "2026-01-20T00:00:00Z",
      historyDays: 19,
      commitsByDay: {},
      distinctCommitDays: 15,
      maxSingleDayCommitShare: 0.1,
      authorStats: { sampled: 200, distinctAuthors: 3, maxAuthorShare: 0.5 },
      messageStats: { sampled: 200, distinctMessageRatio: 0.9, genericMessageShare: 0.05 },
      truncated: false
    });
    getPushEventSummary.mockReset().mockResolvedValue({
      available: false,
      distinctPushDays: 0,
      maxSinglePushCommitShare: 0
    });
    withShallowClone.mockReset().mockImplementation(async (_r, _t, fn) => fn("/fake/dir"));
    scanSource.mockReset().mockResolvedValue({
      byLanguage: [{ language: "TypeScript", lines: 9000, files: 60 }],
      totalLines: 9000,
      totalFiles: 60,
      primaryLanguage: "TypeScript",
      skippedLargeFiles: 0
    });
    cacheGet.mockReset().mockResolvedValue(undefined);
    cacheSet.mockReset().mockResolvedValue(undefined);
    metrics.reset();
  });

  it("answers from cache when a fresh result is there and refresh wasn't asked for", async () => {
    cacheGet.mockResolvedValue(CACHED_RESULT);

    const result = await evaluateEligibility(ref, undefined);

    expect(result.reasons).toEqual(["stale answer from the cache"]);
    expect(withShallowClone).not.toHaveBeenCalled();
  });

  it("recomputes, ignoring a cached result, when refresh is asked for", async () => {
    cacheGet.mockResolvedValue(CACHED_RESULT);

    const result = await evaluateEligibility({ ...ref, repo: "refreshed" }, undefined, {
      refresh: true
    });

    expect(result.eligible).toBe(true);
    expect(withShallowClone).toHaveBeenCalledTimes(1);
  });

  it("stores the recomputed result, so the next caller gets the fresh one", async () => {
    cacheGet.mockResolvedValue(CACHED_RESULT);

    await evaluateEligibility({ ...ref, repo: "stored" }, undefined, { refresh: true });

    expect(cacheSet).toHaveBeenCalledWith(
      "github/acme/stored",
      expect.objectContaining({ eligible: true })
    );
  });

  it("counts a refresh apart from a miss, since it's the expensive path", async () => {
    cacheGet.mockResolvedValue(CACHED_RESULT);

    await evaluateEligibility({ ...ref, repo: "counted" }, undefined, { refresh: true });

    const snapshot = metrics.snapshot();
    expect(snapshot.cacheRefreshes).toBe(1);
    expect(snapshot.cacheMisses).toBe(0);
    expect(snapshot.cacheHits).toBe(0);
  });

  it("doesn't even read the cache on a refresh", async () => {
    await evaluateEligibility({ ...ref, repo: "unread" }, undefined, { refresh: true });

    expect(cacheGet).not.toHaveBeenCalled();
  });

  it("coalesces a burst of refreshes for one repo into a single clone", async () => {
    // Otherwise a client that retries refresh in a loop turns each attempt
    // into its own clone and its own pair of API calls.
    let release: (() => void) | undefined;
    withShallowClone.mockImplementation(async (_r, _t, fn) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return fn("/fake/dir");
    });

    const burstRef = { ...ref, repo: "burst" };
    const all = Promise.all([
      evaluateEligibility(burstRef, undefined, { refresh: true }),
      evaluateEligibility(burstRef, undefined, { refresh: true }),
      evaluateEligibility(burstRef, undefined, { refresh: true })
    ]);
    release?.();
    const results = await all;

    expect(withShallowClone).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r.eligible)).toBe(true);
  });
});

describe("POST /eligibility/check with refresh", () => {
  beforeEach(() => {
    cacheGet.mockReset().mockResolvedValue(undefined);
    cacheSet.mockReset().mockResolvedValue(undefined);
    withShallowClone.mockReset().mockImplementation(async (_r, _t, fn) => fn("/fake/dir"));
    metrics.reset();
  });

  it("passes refresh through to the evaluation", async () => {
    cacheGet.mockResolvedValue({ ...CACHED_RESULT, repo: { ...ref, repo: "via-http" } });

    const res = await request(createApp())
      .post("/eligibility/check")
      .send({ repo: "acme/via-http", refresh: true });

    expect(res.status).toBe(200);
    expect(res.body.eligible).toBe(true);
    expect(metrics.snapshot().cacheRefreshes).toBe(1);
  });

  it("defaults to the cache when refresh is omitted", async () => {
    cacheGet.mockResolvedValue({ ...CACHED_RESULT, repo: { ...ref, repo: "default" } });

    const res = await request(createApp())
      .post("/eligibility/check")
      .send({ repo: "acme/default" });

    expect(res.body.reasons).toEqual(["stale answer from the cache"]);
  });

  it("rejects a non-boolean refresh rather than guessing what it meant", async () => {
    const res = await request(createApp())
      .post("/eligibility/check")
      .send({ repo: "acme/widgets", refresh: "yes please" });

    expect(res.status).toBe(400);
  });

  it("accepts refresh on a batch too", async () => {
    cacheGet.mockResolvedValue({ ...CACHED_RESULT, repo: { ...ref, repo: "batched" } });

    const res = await request(createApp())
      .post("/eligibility/check-batch")
      .send({ repos: ["acme/batched"], refresh: true });

    expect(res.status).toBe(200);
    expect(res.body.results[0].eligible).toBe(true);
  });
});
