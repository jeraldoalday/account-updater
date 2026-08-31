import type { CircuitState } from "../net/circuitBreaker";
import type { ServiceSnapshot } from "./serviceSnapshot";

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
 * Circuit state as a number, since Prometheus has no string values.
 *
 * Ordered by how bad it is, so `max by (provider)` and a threshold alert
 * both do the obvious thing, and so a graph of it reads top to bottom the
 * way an incident does.
 */
const CIRCUIT_STATE_VALUES: Record<CircuitState, number> = {
  closed: 0,
  "half-open": 1,
  open: 2
};

/**
 * Renders the same data as GET /metrics (JSON) in Prometheus's text
 * exposition format, for scraping by a Prometheus server instead of (or
 * alongside) a caller that just wants the plain JSON snapshot.
 */
export function toPrometheusText(snapshot: ServiceSnapshot): string {
  const lines: string[] = [
    ...counter(
      "account_updater_requests_total",
      "Total HTTP requests handled",
      snapshot.requestsTotal
    ),
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
    ...counter(
      "account_updater_cache_hits_total",
      "Eligibility result cache hits",
      snapshot.cacheHits
    ),
    ...counter(
      "account_updater_cache_misses_total",
      "Eligibility result cache misses",
      snapshot.cacheMisses
    ),
    ...counter(
      "account_updater_cache_errors_total",
      "Eligibility result cache reads/writes that failed (result still computed)",
      snapshot.cacheErrors
    ),
    ...counter(
      "account_updater_cache_refreshes_total",
      "Requests that asked for a recomputation, bypassing a cached result",
      snapshot.cacheRefreshes
    ),
    "# HELP account_updater_eligibility_checks_by_provider_total Eligibility checks performed, by forge and outcome",
    "# TYPE account_updater_eligibility_checks_by_provider_total counter",
    // One series per (provider, outcome) rather than a separate metric per
    // outcome: a dashboard summing over the outcome label gets the
    // provider total, which is not something it could reconstruct the
    // other way around.
    ...Object.entries(snapshot.eligibilityByProvider).flatMap(([provider, stats]) => [
      metricLine("account_updater_eligibility_checks_by_provider_total", stats.passed, {
        provider,
        outcome: "passed"
      }),
      metricLine("account_updater_eligibility_checks_by_provider_total", stats.failed, {
        provider,
        outcome: "failed"
      })
    ]),
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
    ),
    "# HELP account_updater_provider_circuit_state Provider circuit breaker state (0 closed, 1 half-open, 2 open)",
    "# TYPE account_updater_provider_circuit_state gauge",
    // Emitted for every forge, including the healthy ones. A series that
    // only appears when a forge breaks cannot be alerted on the way a
    // series that is always 0 and goes to 2 can, and an absent series is
    // indistinguishable from a scrape that failed.
    ...Object.entries(snapshot.providerCircuits).map(([provider, circuit]) =>
      metricLine("account_updater_provider_circuit_state", CIRCUIT_STATE_VALUES[circuit.state], {
        provider
      })
    ),
    "# HELP account_updater_provider_consecutive_failures Consecutive failures counted against a forge's circuit breaker",
    "# TYPE account_updater_provider_consecutive_failures gauge",
    // The early warning: this climbs while the circuit is still closed, so
    // a forge starting to wobble is visible before it is cut off.
    ...Object.entries(snapshot.providerCircuits).map(([provider, circuit]) =>
      metricLine("account_updater_provider_consecutive_failures", circuit.consecutiveFailures, {
        provider
      })
    )
  ];

  return lines.join("\n") + "\n";
}
