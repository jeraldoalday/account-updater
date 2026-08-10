export interface MetricsSnapshot {
  requestsTotal: number;
  requestsByStatusClass: Record<string, number>;
  eligibilityChecksTotal: number;
  eligibilityPassed: number;
  eligibilityFailed: number;
  cacheHits: number;
  cacheMisses: number;
}

/**
 * Minimal in-memory counters for GET /metrics. Per-process only — a
 * multi-instance deployment would need a shared store (e.g. Prometheus
 * scraping each instance, or a shared counter store) for a global view.
 */
class Metrics {
  private requestsTotal = 0;
  private requestsByStatusClass: Record<string, number> = {};
  private eligibilityChecksTotal = 0;
  private eligibilityPassed = 0;
  private eligibilityFailed = 0;
  private cacheHits = 0;
  private cacheMisses = 0;

  recordRequest(statusCode: number): void {
    this.requestsTotal++;
    const statusClass = `${Math.floor(statusCode / 100)}xx`;
    this.requestsByStatusClass[statusClass] = (this.requestsByStatusClass[statusClass] ?? 0) + 1;
  }

  recordEligibilityCheck(eligible: boolean): void {
    this.eligibilityChecksTotal++;
    if (eligible) this.eligibilityPassed++;
    else this.eligibilityFailed++;
  }

  recordCacheHit(): void {
    this.cacheHits++;
  }

  recordCacheMiss(): void {
    this.cacheMisses++;
  }

  snapshot(): MetricsSnapshot {
    return {
      requestsTotal: this.requestsTotal,
      requestsByStatusClass: { ...this.requestsByStatusClass },
      eligibilityChecksTotal: this.eligibilityChecksTotal,
      eligibilityPassed: this.eligibilityPassed,
      eligibilityFailed: this.eligibilityFailed,
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses
    };
  }

  reset(): void {
    this.requestsTotal = 0;
    this.requestsByStatusClass = {};
    this.eligibilityChecksTotal = 0;
    this.eligibilityPassed = 0;
    this.eligibilityFailed = 0;
    this.cacheHits = 0;
    this.cacheMisses = 0;
  }
}

export const metrics = new Metrics();
