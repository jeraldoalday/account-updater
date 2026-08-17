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
});
