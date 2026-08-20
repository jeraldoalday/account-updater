import { beforeEach, describe, expect, it } from "vitest";
import { metrics } from "../src/metrics/metrics";

describe("metrics", () => {
  beforeEach(() => {
    metrics.reset();
  });

  it("starts at zero", () => {
    expect(metrics.snapshot()).toEqual({
      requestsTotal: 0,
      requestsByStatusClass: {},
      eligibilityChecksTotal: 0,
      eligibilityPassed: 0,
      eligibilityFailed: 0,
      cacheHits: 0,
      cacheMisses: 0,
      cacheErrors: 0,
      cacheRefreshes: 0,
      stageDurations: {}
    });
  });

  it("buckets requests by status class", () => {
    metrics.recordRequest(200);
    metrics.recordRequest(201);
    metrics.recordRequest(404);
    metrics.recordRequest(500);

    expect(metrics.snapshot().requestsTotal).toBe(4);
    expect(metrics.snapshot().requestsByStatusClass).toEqual({ "2xx": 2, "4xx": 1, "5xx": 1 });
  });

  it("tracks eligibility pass/fail counts", () => {
    metrics.recordEligibilityCheck(true);
    metrics.recordEligibilityCheck(false);
    metrics.recordEligibilityCheck(true);

    const snapshot = metrics.snapshot();
    expect(snapshot.eligibilityChecksTotal).toBe(3);
    expect(snapshot.eligibilityPassed).toBe(2);
    expect(snapshot.eligibilityFailed).toBe(1);
  });

  it("tracks cache hits and misses independently", () => {
    metrics.recordCacheMiss();
    metrics.recordCacheMiss();
    metrics.recordCacheHit();

    const snapshot = metrics.snapshot();
    expect(snapshot.cacheMisses).toBe(2);
    expect(snapshot.cacheHits).toBe(1);
  });

  it("counts cache errors separately from hits and misses", () => {
    // A failed cache read is neither a hit nor a miss: counting it as a
    // miss would hide a broken backend behind a normal-looking hit rate.
    metrics.recordCacheMiss();
    metrics.recordCacheError();
    metrics.recordCacheError();

    const snapshot = metrics.snapshot();
    expect(snapshot.cacheErrors).toBe(2);
    expect(snapshot.cacheMisses).toBe(1);
    expect(snapshot.cacheHits).toBe(0);
  });

  it("resets cache errors along with every other counter", () => {
    metrics.recordCacheError();
    metrics.reset();
    expect(metrics.snapshot().cacheErrors).toBe(0);
  });

  it("aggregates per-stage durations into count/avg/max, keyed independently per stage", () => {
    metrics.recordStageDuration("cloneAndScan", 100);
    metrics.recordStageDuration("cloneAndScan", 300);
    metrics.recordStageDuration("commitHistory", 50);

    const snapshot = metrics.snapshot();
    expect(snapshot.stageDurations).toEqual({
      cloneAndScan: { count: 2, avgMs: 200, maxMs: 300 },
      commitHistory: { count: 1, avgMs: 50, maxMs: 50 }
    });
  });
  it("counts a forced refresh apart from a hit or a miss", () => {
    metrics.recordCacheRefresh();
    metrics.recordCacheRefresh();

    const snapshot = metrics.snapshot();
    expect(snapshot.cacheRefreshes).toBe(2);
    expect(snapshot.cacheHits).toBe(0);
    expect(snapshot.cacheMisses).toBe(0);
  });
});
