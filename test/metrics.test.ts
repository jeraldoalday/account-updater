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
      cacheMisses: 0
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
});
