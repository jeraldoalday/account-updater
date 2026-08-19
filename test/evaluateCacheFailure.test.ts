import { beforeEach, describe, expect, it, vi } from "vitest";
import { metrics } from "../src/metrics/metrics";

const getCommitHistorySummary = vi.fn();
const getPushEventSummary = vi.fn();
const withShallowClone = vi.fn();
const scanSource = vi.fn();
const cacheGet = vi.fn();
const cacheSet = vi.fn();

vi.mock("../src/providers/registry", () => ({
  createProvider: () => ({ id: "github", getCommitHistorySummary, getPushEventSummary })
}));

vi.mock("../src/clone/tempClone", () => ({
  withShallowClone: (...args: unknown[]) => withShallowClone(...args)
}));

vi.mock("../src/analysis/sourceScan", () => ({
  scanSource: (...args: unknown[]) => scanSource(...args)
}));

vi.mock("../src/history/createHistoryStore", () => ({
  createHistoryStore: () => ({ record: vi.fn() })
}));

// Stands in for a shared Redis backend that can fail mid-request, which an
// in-memory cache never does.
vi.mock("../src/cache/createCache", () => ({
  createCache: () => ({
    get: (...args: unknown[]) => cacheGet(...args),
    set: (...args: unknown[]) => cacheSet(...args),
    clear: vi.fn()
  })
}));

const { evaluateEligibility } = await import("../src/eligibility/evaluate");

const ref = { provider: "github" as const, owner: "acme", repo: "widgets" };

describe("evaluateEligibility when the cache backend is unavailable", () => {
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
    withShallowClone.mockReset().mockImplementation(async (_ref, _token, fn) => fn("/fake/dir"));
    scanSource.mockReset().mockResolvedValue({
      byLanguage: [{ language: "TypeScript", lines: 9000, files: 60 }],
      totalLines: 9000,
      totalFiles: 60,
      primaryLanguage: "TypeScript"
    });
    cacheGet.mockReset().mockResolvedValue(undefined);
    cacheSet.mockReset().mockResolvedValue(undefined);
    metrics.reset();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("still answers when a cache read fails, treating it as a miss", async () => {
    cacheGet.mockRejectedValue(new Error("Redis connection refused"));

    const result = await evaluateEligibility(ref, undefined, { cacheable: true });

    expect(result.eligible).toBe(true);
    expect(withShallowClone).toHaveBeenCalledTimes(1);
    expect(metrics.snapshot().cacheErrors).toBe(1);
  });

  it("still answers when a cache write fails after a successful evaluation", async () => {
    cacheSet.mockRejectedValue(new Error("Redis connection refused"));

    const result = await evaluateEligibility({ ...ref, repo: "write-failure" }, undefined, {
      cacheable: true
    });

    // The expensive work already succeeded; failing the caller because the
    // result couldn't be stored would throw away a correct answer.
    expect(result.eligible).toBe(true);
    expect(metrics.snapshot().cacheErrors).toBe(1);
  });

  it("logs the failure so the degradation is diagnosable, not silent", async () => {
    cacheGet.mockRejectedValue(new Error("Redis connection refused"));

    await evaluateEligibility({ ...ref, repo: "logged" }, undefined, { cacheable: true });

    const logged = (console.error as unknown as { mock: { calls: string[][] } }).mock.calls
      .map((args) => String(args[0]))
      .join("\n");
    expect(logged).toContain("cache_unavailable");
    expect(logged).toContain("Redis connection refused");
  });

  it("clears the in-flight entry after a failed evaluation so the next request retries", async () => {
    withShallowClone.mockRejectedValueOnce(new Error("clone failed"));
    const failingRef = { ...ref, repo: "retry-after-failure" };

    await expect(evaluateEligibility(failingRef, undefined, { cacheable: true })).rejects.toThrow(
      "clone failed"
    );

    // A failed evaluation must not be cached, and must not leave a rejected
    // promise behind for later callers to be handed forever.
    const second = await evaluateEligibility(failingRef, undefined, { cacheable: true });
    expect(second.eligible).toBe(true);
    expect(cacheSet).not.toHaveBeenCalledWith(expect.stringContaining("retry-after-failure"), {
      eligible: false
    });
  });
});
