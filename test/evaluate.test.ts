import { beforeEach, describe, expect, it, vi } from "vitest";
import { metrics } from "../src/metrics/metrics";

const getCommitHistorySummary = vi.fn();
const getPushEventSummary = vi.fn();
const withShallowClone = vi.fn();
const scanSource = vi.fn();
const recordHistory = vi.fn();
const createProvider = vi.fn((_providerId: string, _token?: string) => ({
  id: "github",
  getCommitHistorySummary,
  getPushEventSummary
}));

vi.mock("../src/providers/registry", () => ({
  createProvider: (providerId: string, token?: string) => createProvider(providerId, token)
}));

vi.mock("../src/clone/tempClone", () => ({
  withShallowClone: (...args: unknown[]) => withShallowClone(...args)
}));

vi.mock("../src/analysis/sourceScan", () => ({
  scanSource: (...args: unknown[]) => scanSource(...args)
}));

vi.mock("../src/history/createHistoryStore", () => ({
  createHistoryStore: () => ({ record: (...args: unknown[]) => recordHistory(...args) })
}));

const { evaluateEligibility } = await import("../src/eligibility/evaluate");

describe("evaluateEligibility caching", () => {
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
    recordHistory.mockReset();
    createProvider.mockClear();
    metrics.reset();
  });

  it("computes once and reuses the cached result for cacheable requests", async () => {
    const ref = { provider: "github" as const, owner: "cache-test-owner", repo: "cache-test-repo" };

    const first = await evaluateEligibility(ref, undefined, { cacheable: true });
    const second = await evaluateEligibility(ref, undefined, { cacheable: true });

    expect(second).toEqual(first);
    expect(withShallowClone).toHaveBeenCalledTimes(1);
    expect(getCommitHistorySummary).toHaveBeenCalledTimes(1);

    const snapshot = metrics.snapshot();
    expect(snapshot.cacheMisses).toBe(1);
    expect(snapshot.cacheHits).toBe(1);
    expect(snapshot.eligibilityChecksTotal).toBe(1);
    expect(snapshot.eligibilityPassed).toBe(1);
  });

  it("recomputes every time for non-cacheable (per-request-token) requests", async () => {
    const ref = {
      provider: "github" as const,
      owner: "cache-test-owner-2",
      repo: "cache-test-repo-2"
    };

    await evaluateEligibility(ref, "caller-token", { cacheable: false });
    await evaluateEligibility(ref, "caller-token", { cacheable: false });

    expect(withShallowClone).toHaveBeenCalledTimes(2);
  });

  it("does not mix cacheable and non-cacheable results for the same repo", async () => {
    const ref = {
      provider: "github" as const,
      owner: "cache-test-owner-3",
      repo: "cache-test-repo-3"
    };

    await evaluateEligibility(ref, undefined, { cacheable: true });
    await evaluateEligibility(ref, "caller-token", { cacheable: false });

    expect(withShallowClone).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent cache-miss requests for the same repo into one computation", async () => {
    const ref = {
      provider: "github" as const,
      owner: "cache-test-owner-4",
      repo: "cache-test-repo-4"
    };

    const [first, second, third] = await Promise.all([
      evaluateEligibility(ref, undefined, { cacheable: true }),
      evaluateEligibility(ref, undefined, { cacheable: true }),
      evaluateEligibility(ref, undefined, { cacheable: true })
    ]);

    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(withShallowClone).toHaveBeenCalledTimes(1);
    expect(getCommitHistorySummary).toHaveBeenCalledTimes(1);

    // The result is cached for later requests too, not just shared among
    // the concurrent ones.
    await evaluateEligibility(ref, undefined, { cacheable: true });
    expect(withShallowClone).toHaveBeenCalledTimes(1);
  });

  it("records one history entry per evaluation actually performed, not per request served", async () => {
    const ref = {
      provider: "github" as const,
      owner: "cache-test-owner-6",
      repo: "cache-test-repo-6"
    };

    const first = await evaluateEligibility(ref, undefined, { cacheable: true });
    await evaluateEligibility(ref, undefined, { cacheable: true }); // cache hit

    expect(recordHistory).toHaveBeenCalledTimes(1);
    expect(recordHistory).toHaveBeenCalledWith(first);
  });

  it("scopes the cache key by provider, so the same owner/repo on two forges is two entries", async () => {
    const githubRef = { provider: "github" as const, owner: "dual", repo: "named" };
    const gitlabRef = { provider: "gitlab" as const, owner: "dual", repo: "named" };

    await evaluateEligibility(githubRef, undefined, { cacheable: true });
    await evaluateEligibility(gitlabRef, undefined, { cacheable: true });

    expect(withShallowClone).toHaveBeenCalledTimes(2);
    expect(createProvider).toHaveBeenNthCalledWith(1, "github", undefined);
    expect(createProvider).toHaveBeenNthCalledWith(2, "gitlab", undefined);
  });

  it("builds the provider from the ref and the caller's token", async () => {
    const ref = { provider: "github" as const, owner: "token-test", repo: "repo" };
    await evaluateEligibility(ref, "caller-token", { cacheable: false });
    expect(createProvider).toHaveBeenCalledWith("github", "caller-token");
  });

  it("does not start clone or API work when the provider is unsupported", async () => {
    createProvider.mockImplementationOnce(() => {
      throw new Error("GitLab repositories are not supported yet");
    });
    const ref = { provider: "gitlab" as const, owner: "unsupported", repo: "repo" };

    await expect(evaluateEligibility(ref, undefined, { cacheable: false })).rejects.toThrow(
      /not supported yet/
    );
    expect(withShallowClone).not.toHaveBeenCalled();
    expect(getCommitHistorySummary).not.toHaveBeenCalled();
  });

  it("does not coalesce concurrent requests for different repos", async () => {
    const refA = {
      provider: "github" as const,
      owner: "cache-test-owner-5a",
      repo: "cache-test-repo-5a"
    };
    const refB = {
      provider: "github" as const,
      owner: "cache-test-owner-5b",
      repo: "cache-test-repo-5b"
    };

    await Promise.all([
      evaluateEligibility(refA, undefined, { cacheable: true }),
      evaluateEligibility(refB, undefined, { cacheable: true })
    ]);

    expect(withShallowClone).toHaveBeenCalledTimes(2);
  });
});
