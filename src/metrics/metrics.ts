export interface StageDurationStats {
  count: number;
  avgMs: number;
  maxMs: number;
}

export interface ProviderCheckStats {
  total: number;
  passed: number;
  failed: number;
}

export interface MetricsSnapshot {
  requestsTotal: number;
  requestsByStatusClass: Record<string, number>;
  eligibilityChecksTotal: number;
  eligibilityPassed: number;
  eligibilityFailed: number;
  cacheHits: number;
  cacheMisses: number;
  // Cache reads/writes that failed outright (e.g. Redis unreachable). The
  // request still succeeds by computing the result, so without this
  // counter a degraded shared cache is invisible: hit rate collapses and
  // nothing says why.
  cacheErrors: number;
  // Requests that asked for a recomputation with `refresh`, bypassing a
  // possibly-fresh cached result. Counted separately because they are the
  // expensive path (always a clone plus API calls) and a client looping on
  // refresh is otherwise indistinguishable from a collapsed hit rate.
  cacheRefreshes: number;
  // The same pass/fail counts split by forge. Now that more than one is
  // implemented, the totals alone can't answer the question an operator
  // actually has when a pass rate moves: whether something changed about
  // the service, or whether one provider's traffic changed shape. A
  // provider appears here only once it has been checked, so the map stays
  // a record of what this instance really saw.
  eligibilityByProvider: Record<string, ProviderCheckStats>;
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
  private cacheErrors = 0;
  private cacheRefreshes = 0;
  private eligibilityByProvider: Record<string, ProviderCheckStats> = {};
  private stageDurations: Record<string, { count: number; totalMs: number; maxMs: number }> = {};

  recordRequest(statusCode: number): void {
    this.requestsTotal++;
    const statusClass = `${Math.floor(statusCode / 100)}xx`;
    this.requestsByStatusClass[statusClass] = (this.requestsByStatusClass[statusClass] ?? 0) + 1;
  }

  recordEligibilityCheck(eligible: boolean, provider?: string): void {
    this.eligibilityChecksTotal++;
    if (eligible) this.eligibilityPassed++;
    else this.eligibilityFailed++;

    // Optional so a caller that has no ref in hand - a test, or any future
    // call site - can still count the check rather than being forced to
    // invent a provider label that would pollute the breakdown.
    if (provider === undefined) return;
    const stats = this.eligibilityByProvider[provider] ?? { total: 0, passed: 0, failed: 0 };
    stats.total++;
    if (eligible) stats.passed++;
    else stats.failed++;
    this.eligibilityByProvider[provider] = stats;
  }

  recordCacheHit(): void {
    this.cacheHits++;
  }

  recordCacheMiss(): void {
    this.cacheMisses++;
  }

  recordCacheError(): void {
    this.cacheErrors++;
  }

  recordCacheRefresh(): void {
    this.cacheRefreshes++;
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
      cacheErrors: this.cacheErrors,
      cacheRefreshes: this.cacheRefreshes,
      eligibilityByProvider: Object.fromEntries(
        Object.entries(this.eligibilityByProvider).map(([provider, stats]) => [
          provider,
          { ...stats }
        ])
      ),
      stageDurations: Object.fromEntries(
        Object.entries(this.stageDurations).map(([stage, s]) => [
          stage,
          {
            count: s.count,
            avgMs: Number((s.totalMs / s.count).toFixed(1)),
            maxMs: Number(s.maxMs.toFixed(1))
          }
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
    this.cacheErrors = 0;
    this.cacheRefreshes = 0;
    this.eligibilityByProvider = {};
    this.stageDurations = {};
  }
}

export const metrics = new Metrics();
