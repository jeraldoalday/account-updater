export interface StageDurationStats {
  count: number;
  avgMs: number;
  maxMs: number;
}

export interface MetricsSnapshot {
  requestsTotal: number;
  requestsByStatusClass: Record<string, number>;
  eligibilityChecksTotal: number;
  eligibilityPassed: number;
  eligibilityFailed: number;
  cacheHits: number;
  cacheMisses: number;
  // Per-stage timing of eligibility checks actually performed (a cache hit
  // records nothing here, same as eligibilityChecksTotal), so a slow check
  // is diagnosable by stage - e.g. is the clone slow, or the GitHub API -
  // rather than only visible as one opaque total duration.
  stageDurations: Record<string, StageDurationStats>;
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
  private stageDurations: Record<string, { count: number; totalMs: number; maxMs: number }> = {};

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

  recordStageDuration(stage: string, durationMs: number): void {
    const existing = this.stageDurations[stage] ?? { count: 0, totalMs: 0, maxMs: 0 };
    existing.count++;
    existing.totalMs += durationMs;
    existing.maxMs = Math.max(existing.maxMs, durationMs);
    this.stageDurations[stage] = existing;
  }

  snapshot(): MetricsSnapshot {
    return {
      requestsTotal: this.requestsTotal,
      requestsByStatusClass: { ...this.requestsByStatusClass },
      eligibilityChecksTotal: this.eligibilityChecksTotal,
      eligibilityPassed: this.eligibilityPassed,
      eligibilityFailed: this.eligibilityFailed,
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
      stageDurations: Object.fromEntries(
        Object.entries(this.stageDurations).map(([stage, s]) => [
          stage,
          { count: s.count, avgMs: Number((s.totalMs / s.count).toFixed(1)), maxMs: Number(s.maxMs.toFixed(1)) }
        ])
      )
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
    this.stageDurations = {};
  }
}

export const metrics = new Metrics();
