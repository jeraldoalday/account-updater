import { describe, expect, it } from "vitest";
import { toPrometheusText } from "../src/metrics/prometheusFormat";
import type { MetricsSnapshot } from "../src/metrics/metrics";

function emptySnapshot(): MetricsSnapshot {
  return {
    requestsTotal: 0,
    requestsByStatusClass: {},
    eligibilityChecksTotal: 0,
    eligibilityPassed: 0,
    eligibilityFailed: 0,
    cacheHits: 0,
    cacheMisses: 0,
    cacheErrors: 0,
    cacheRefreshes: 0,
    eligibilityByProvider: {},
    stageDurations: {}
  };
}

describe("toPrometheusText", () => {
  it("renders scalar counters with HELP/TYPE lines and no labels", () => {
    const text = toPrometheusText({ ...emptySnapshot(), requestsTotal: 42 });

    expect(text).toContain("# HELP account_updater_requests_total");
    expect(text).toContain("# TYPE account_updater_requests_total counter");
    expect(text).toContain("account_updater_requests_total 42");
  });

  it("renders requestsByStatusClass as one labeled series per status class", () => {
    const text = toPrometheusText({
      ...emptySnapshot(),
      requestsByStatusClass: { "2xx": 10, "4xx": 2 }
    });

    expect(text).toContain('account_updater_requests_by_status_total{status_class="2xx"} 10');
    expect(text).toContain('account_updater_requests_by_status_total{status_class="4xx"} 2');
  });

  it("renders per-stage duration stats as separate count/avg/max series", () => {
    const text = toPrometheusText({
      ...emptySnapshot(),
      stageDurations: { cloneAndScan: { count: 5, avgMs: 120.5, maxMs: 300 } }
    });

    expect(text).toContain('account_updater_stage_duration_count_total{stage="cloneAndScan"} 5');
    expect(text).toContain('account_updater_stage_duration_avg_ms{stage="cloneAndScan"} 120.5');
    expect(text).toContain('account_updater_stage_duration_max_ms{stage="cloneAndScan"} 300');
  });

  it("escapes quotes and backslashes in label values", () => {
    const text = toPrometheusText({
      ...emptySnapshot(),
      requestsByStatusClass: { 'weird"label\\value': 1 }
    });

    expect(text).toContain('status_class="weird\\"label\\\\value"');
  });

  it("ends with a trailing newline", () => {
    const text = toPrometheusText(emptySnapshot());
    expect(text.endsWith("\n")).toBe(true);
  });

  it("exposes cache errors so a degraded shared cache is visible to scrapers", () => {
    const text = toPrometheusText({ ...emptySnapshot(), cacheErrors: 3 });
    expect(text).toContain("# TYPE account_updater_cache_errors_total counter");
    expect(text).toContain("account_updater_cache_errors_total 3");
  });
  it("exposes the refresh counter", () => {
    const text = toPrometheusText({ ...emptySnapshot(), cacheRefreshes: 4 });

    expect(text).toContain("# TYPE account_updater_cache_refreshes_total counter");
    expect(text).toContain("account_updater_cache_refreshes_total 4");
  });
});

describe("per-provider eligibility series", () => {
  it("renders one series per provider and outcome", () => {
    const text = toPrometheusText({
      ...emptySnapshot(),
      eligibilityByProvider: {
        github: { total: 5, passed: 4, failed: 1 },
        gitlab: { total: 2, passed: 0, failed: 2 }
      }
    });

    expect(text).toContain(
      'account_updater_eligibility_checks_by_provider_total{provider="github",outcome="passed"} 4'
    );
    expect(text).toContain(
      'account_updater_eligibility_checks_by_provider_total{provider="github",outcome="failed"} 1'
    );
    expect(text).toContain(
      'account_updater_eligibility_checks_by_provider_total{provider="gitlab",outcome="failed"} 2'
    );
  });

  it("declares the series once, not once per provider", () => {
    const text = toPrometheusText({
      ...emptySnapshot(),
      eligibilityByProvider: {
        github: { total: 1, passed: 1, failed: 0 },
        gitlab: { total: 1, passed: 1, failed: 0 }
      }
    });

    // A repeated HELP/TYPE block for the same metric name is malformed
    // exposition, and some scrapers reject the whole scrape over it.
    const typeLines = text
      .split("\n")
      .filter((line) => line.startsWith("# TYPE account_updater_eligibility_checks_by_provider"));
    expect(typeLines).toHaveLength(1);
  });

  it("emits no series at all before any check has run", () => {
    const text = toPrometheusText(emptySnapshot());

    expect(text).not.toContain("account_updater_eligibility_checks_by_provider_total{");
  });
});
