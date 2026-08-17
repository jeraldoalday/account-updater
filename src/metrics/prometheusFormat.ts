import type { MetricsSnapshot } from "./metrics";

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function metricLine(name: string, value: number, labels: Record<string, string> = {}): string {
  const labelPairs = Object.entries(labels)
    .map(([key, val]) => `${key}="${escapeLabelValue(val)}"`)
    .join(",");
  return `${name}${labelPairs ? `{${labelPairs}}` : ""} ${value}`;
}

function counter(name: string, help: string, value: number): string[] {
  return [`# HELP ${name} ${help}`, `# TYPE ${name} counter`, metricLine(name, value)];
}

/**
 * Renders the same data as GET /metrics (JSON) in Prometheus's text
 * exposition format, for scraping by a Prometheus server instead of (or
 * alongside) a caller that just wants the plain JSON snapshot.
 */
export function toPrometheusText(snapshot: MetricsSnapshot): string {
  const lines: string[] = [
    ...counter("account_updater_requests_total", "Total HTTP requests handled", snapshot.requestsTotal),
    "# HELP account_updater_requests_by_status_total HTTP requests handled, by status class",
    "# TYPE account_updater_requests_by_status_total counter",
    ...Object.entries(snapshot.requestsByStatusClass).map(([statusClass, count]) =>
      metricLine("account_updater_requests_by_status_total", count, { status_class: statusClass })
    ),
    ...counter(
      "account_updater_eligibility_checks_total",
      "Total eligibility checks performed (excludes cache hits)",
      snapshot.eligibilityChecksTotal
    ),
    ...counter(
      "account_updater_eligibility_passed_total",
      "Eligibility checks that passed",
      snapshot.eligibilityPassed
    ),
    ...counter(
      "account_updater_eligibility_failed_total",
      "Eligibility checks that failed",
      snapshot.eligibilityFailed
    ),
    ...counter("account_updater_cache_hits_total", "Eligibility result cache hits", snapshot.cacheHits),
    ...counter(
      "account_updater_cache_misses_total",
      "Eligibility result cache misses",
      snapshot.cacheMisses
    ),
    "# HELP account_updater_stage_duration_count_total Evaluation stage observations, by stage",
    "# TYPE account_updater_stage_duration_count_total counter",
    ...Object.entries(snapshot.stageDurations).map(([stage, stats]) =>
      metricLine("account_updater_stage_duration_count_total", stats.count, { stage })
    ),
    "# HELP account_updater_stage_duration_avg_ms Average evaluation stage duration, in milliseconds",
    "# TYPE account_updater_stage_duration_avg_ms gauge",
    ...Object.entries(snapshot.stageDurations).map(([stage, stats]) =>
      metricLine("account_updater_stage_duration_avg_ms", stats.avgMs, { stage })
    ),
    "# HELP account_updater_stage_duration_max_ms Max observed evaluation stage duration, in milliseconds",
    "# TYPE account_updater_stage_duration_max_ms gauge",
    ...Object.entries(snapshot.stageDurations).map(([stage, stats]) =>
      metricLine("account_updater_stage_duration_max_ms", stats.maxMs, { stage })
    )
  ];

  return lines.join("\n") + "\n";
}
