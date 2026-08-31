import { beforeEach, describe, expect, it, vi } from "vitest";

const getCommitHistorySummary = vi.fn();
const getPushEventSummary = vi.fn();
const withShallowClone = vi.fn();
const scanSource = vi.fn();

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

vi.mock("../src/cache/createCache", () => ({
  createCache: () => ({
    get: async () => undefined,
    set: async () => undefined,
    clear: vi.fn()
  })
}));

const { evaluateEligibility } = await import("../src/eligibility/evaluate");

const ref = { provider: "github" as const, owner: "acme", repo: "widgets" };

const HISTORY = {
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
};

const SCAN = {
  byLanguage: [{ language: "TypeScript", lines: 9000, files: 60 }],
  totalLines: 9000,
  totalFiles: 60,
  primaryLanguage: "TypeScript",
  skippedLargeFiles: 0
};

/**
 * Holds each clone open until it is explicitly released, so a test can
 * arrange the thing that actually matters here: a second request arriving
 * while an earlier evaluation of the same repo is still running.
 *
 * Releasing waits for the clones to have actually started first. A plain
 * request reads the cache before it gets as far as cloning, so the clone
 * it will start does not exist yet at the moment the test calls it.
 */
function blockingClones() {
  const releases: (() => void)[] = [];
  withShallowClone.mockImplementation(
    async (_r: unknown, _t: unknown, fn: (d: string) => unknown) => {
      await new Promise<void>((resolve) => releases.push(resolve));
      return fn("/fake/dir");
    }
  );

  async function waitForStarted(count: number): Promise<void> {
    for (let attempt = 0; attempt < 200 && releases.length < count; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  return {
    /** Releases the `count` longest-waiting clones, oldest first. */
    async release(count = 1): Promise<void> {
      await waitForStarted(count);
      releases.splice(0, count).forEach((release) => release());
    },
    async releaseAll(): Promise<void> {
      await waitForStarted(1);
      releases.splice(0).forEach((release) => release());
    }
  };
}

describe("evaluateEligibility while an evaluation of the same repo is running", () => {
  beforeEach(() => {
    getCommitHistorySummary.mockReset().mockResolvedValue(HISTORY);
    getPushEventSummary.mockReset().mockResolvedValue({
      available: false,
      distinctPushDays: 0,
      maxSinglePushCommitShare: 0
    });
    withShallowClone.mockReset().mockImplementation(async (_r, _t, fn) => fn("/fake/dir"));
    scanSource.mockReset().mockResolvedValue(SCAN);
    vi.useRealTimers();
  });

  it("joins a plain request to the running evaluation rather than cloning again", async () => {
    const clones = blockingClones();
    const target = { ...ref, repo: "joined" };

    const first = evaluateEligibility(target, undefined);
    const second = evaluateEligibility(target, undefined);
    await clones.releaseAll();
    await Promise.all([first, second]);

    expect(withShallowClone).toHaveBeenCalledTimes(1);
  });

  // The bug this covers: a refresh means "the thing you rejected this repo
  // for is fixed - look again", and an evaluation that was already running
  // when the request arrived may have read the repo before the fix landed.
  // Answering from it tells the caller their fix didn't work, and the
  // remedy they'd reach for - refresh again - would keep joining the same
  // stale computation for as long as it runs.
  it("does not answer a refresh from work that started before the caller asked", async () => {
    const clones = blockingClones();
    const target = { ...ref, repo: "stale-in-flight" };

    const running = evaluateEligibility(target, undefined);
    // Enough that the running evaluation is unambiguously older than the
    // refresh, the way a clone of a large repo would be.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const refreshed = evaluateEligibility(target, undefined, { refresh: true });

    await clones.releaseAll();
    await Promise.all([running, refreshed]);

    expect(withShallowClone).toHaveBeenCalledTimes(2);
  });

  it("still coalesces refreshes that arrive together into a single clone", async () => {
    const clones = blockingClones();
    const target = { ...ref, repo: "refresh-burst" };

    const all = Promise.all([
      evaluateEligibility(target, undefined, { refresh: true }),
      evaluateEligibility(target, undefined, { refresh: true }),
      evaluateEligibility(target, undefined, { refresh: true })
    ]);
    await clones.releaseAll();
    await all;

    expect(withShallowClone).toHaveBeenCalledTimes(1);
  });

  it("gives the refresh its own answer, not the one the older evaluation produced", async () => {
    const clones = blockingClones();
    const target = { ...ref, repo: "own-answer" };

    // Stands in for the repo being fixed between the two: the older
    // evaluation is reading a history that fails, the refresh a history
    // that passes.
    getCommitHistorySummary.mockResolvedValueOnce({ ...HISTORY, commitCount: 3 });

    const running = evaluateEligibility(target, undefined);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const refreshed = evaluateEligibility(target, undefined, { refresh: true });

    await clones.releaseAll();
    const [before, after] = await Promise.all([running, refreshed]);

    expect(before.eligible).toBe(false);
    expect(after.eligible).toBe(true);
  });

  // A refresh that declines to join replaces the map entry. When the older
  // evaluation then finishes, an unconditional delete would remove the
  // newer entry, and every request behind it would start its own clone.
  it("leaves the newer evaluation joinable after the older one finishes", async () => {
    const clones = blockingClones();
    const target = { ...ref, repo: "entry-survives" };

    const running = evaluateEligibility(target, undefined);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const refreshed = evaluateEligibility(target, undefined, { refresh: true });

    // Only the first clone, so the older evaluation settles while the
    // refresh it was replaced by is still running.
    await clones.release(1);
    await running;

    const joiner = evaluateEligibility(target, undefined);
    await clones.release(1);
    await Promise.all([refreshed, joiner]);

    expect(withShallowClone).toHaveBeenCalledTimes(2);
  });

  it("clears the entry once the evaluation settles, so a later request recomputes", async () => {
    const target = { ...ref, repo: "cleared" };

    await evaluateEligibility(target, undefined);
    await evaluateEligibility(target, undefined);

    expect(withShallowClone).toHaveBeenCalledTimes(2);
  });

  it("does not strand later requests when the running evaluation fails", async () => {
    const target = { ...ref, repo: "failed" };
    getCommitHistorySummary.mockRejectedValueOnce(new Error("upstream exploded"));

    await expect(evaluateEligibility(target, undefined)).rejects.toThrow("upstream exploded");
    await expect(evaluateEligibility(target, undefined)).resolves.toMatchObject({ eligible: true });
  });
});
