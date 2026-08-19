import { mapWithConcurrency } from "../utils/concurrency";

export interface LoadTestOptions {
  /** Base URL of a running service, e.g. http://localhost:3000 */
  url: string;
  /** Repo reference sent as the request body's `repo`. */
  repo: string;
  requests: number;
  concurrency: number;
  apiKey?: string;
}

export interface RequestOutcome {
  status: number;
  durationMs: number;
  /** Set when the request never produced a response at all. */
  error?: string;
}

export interface LatencyStats {
  minMs: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}

export interface MetricsDelta {
  evaluations: number;
  cacheHits: number;
  cacheMisses: number;
  cacheErrors: number;
}

export interface LoadTestReport {
  requests: number;
  concurrency: number;
  wallClockMs: number;
  requestsPerSecond: number;
  byStatus: Record<string, number>;
  rateLimited: number;
  failed: number;
  latency: LatencyStats;
  /** Absent when the service's /metrics endpoint couldn't be read. */
  metricsDelta?: MetricsDelta;
}

const DEFAULTS = { requests: 50, concurrency: 10, url: "http://localhost:3000" };

export class LoadTestArgumentError extends Error {}

function positiveInt(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new LoadTestArgumentError(`--${name} must be a positive integer (got "${raw}")`);
  }
  return value;
}

/**
 * Parses `--flag value` pairs. Deliberately tiny and dependency-free - this
 * is a developer tool, not part of the service, and adding an argument
 * parser to the production dependency tree for it would be a poor trade.
 */
export function parseLoadTestArgs(argv: readonly string[]): LoadTestOptions {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key.startsWith("--")) {
      throw new LoadTestArgumentError(`Expected a --flag, got "${key}"`);
    }
    const value = argv[i + 1];
    if (value === undefined) {
      throw new LoadTestArgumentError(`Missing value for ${key}`);
    }
    flags[key.slice(2)] = value;
  }

  if (!flags.repo) {
    throw new LoadTestArgumentError("--repo is required (e.g. --repo owner/name)");
  }

  return {
    url: (flags.url ?? DEFAULTS.url).replace(/\/+$/, ""),
    repo: flags.repo,
    requests: positiveInt("requests", flags.requests, DEFAULTS.requests),
    concurrency: positiveInt("concurrency", flags.concurrency, DEFAULTS.concurrency),
    apiKey: flags["api-key"]
  };
}

/**
 * Nearest-rank percentile: for p95 of 20 samples it returns the 19th
 * slowest rather than interpolating between neighbours. With the sample
 * sizes a load test like this produces, an interpolated value implies more
 * precision than the data supports.
 */
export function percentile(sortedMs: readonly number[], p: number): number {
  if (sortedMs.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sortedMs.length);
  return sortedMs[Math.min(sortedMs.length - 1, Math.max(0, rank - 1))];
}

export function summarizeLatency(durationsMs: readonly number[]): LatencyStats {
  if (durationsMs.length === 0) {
    return { minMs: 0, avgMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0 };
  }
  const sorted = [...durationsMs].sort((a, b) => a - b);
  const total = sorted.reduce((sum, ms) => sum + ms, 0);
  return {
    minMs: round(sorted[0]),
    avgMs: round(total / sorted.length),
    p50Ms: round(percentile(sorted, 50)),
    p95Ms: round(percentile(sorted, 95)),
    p99Ms: round(percentile(sorted, 99)),
    maxMs: round(sorted[sorted.length - 1])
  };
}

function round(ms: number): number {
  return Number(ms.toFixed(1));
}

export function summarizeOutcomes(
  outcomes: readonly RequestOutcome[],
  options: LoadTestOptions,
  wallClockMs: number
): LoadTestReport {
  const byStatus: Record<string, number> = {};
  for (const outcome of outcomes) {
    const key = outcome.error ? "error" : String(outcome.status);
    byStatus[key] = (byStatus[key] ?? 0) + 1;
  }

  return {
    requests: outcomes.length,
    concurrency: options.concurrency,
    wallClockMs: round(wallClockMs),
    requestsPerSecond: wallClockMs > 0 ? round((outcomes.length / wallClockMs) * 1000) : 0,
    byStatus,
    rateLimited: outcomes.filter((o) => o.status === 429).length,
    failed: outcomes.filter((o) => o.error !== undefined).length,
    latency: summarizeLatency(outcomes.map((o) => o.durationMs))
  };
}

export interface LoadTestDeps {
  fetch: typeof globalThis.fetch;
  now: () => number;
}

interface MetricsSnapshotShape {
  eligibilityChecksTotal?: number;
  cacheHits?: number;
  cacheMisses?: number;
  cacheErrors?: number;
}

async function readMetrics(
  options: LoadTestOptions,
  deps: LoadTestDeps
): Promise<MetricsSnapshotShape | undefined> {
  try {
    const res = await deps.fetch(`${options.url}/metrics`);
    if (!res.ok) return undefined;
    return (await res.json()) as MetricsSnapshotShape;
  } catch {
    // Metrics are a nice-to-have here: the load numbers are still valid
    // without them (e.g. against a service behind a proxy that doesn't
    // expose /metrics).
    return undefined;
  }
}

function metricsDelta(
  before: MetricsSnapshotShape | undefined,
  after: MetricsSnapshotShape | undefined
): MetricsDelta | undefined {
  if (!before || !after) return undefined;
  const diff = (key: keyof MetricsSnapshotShape) => (after[key] ?? 0) - (before[key] ?? 0);
  return {
    evaluations: diff("eligibilityChecksTotal"),
    cacheHits: diff("cacheHits"),
    cacheMisses: diff("cacheMisses"),
    cacheErrors: diff("cacheErrors")
  };
}

/**
 * Fires `requests` eligibility checks for one repo at a fixed concurrency
 * and reports status distribution, latency percentiles, and how many
 * evaluations the service actually performed.
 *
 * Pointing every request at the same repo is the point: the interesting
 * numbers are how many requests the rate limiter rejects, and how few
 * evaluations the cache and in-flight coalescing let through compared to
 * the number of requests made.
 */
export async function runLoadTest(
  options: LoadTestOptions,
  deps: LoadTestDeps = { fetch: globalThis.fetch, now: () => Date.now() }
): Promise<LoadTestReport> {
  const before = await readMetrics(options, deps);
  const start = deps.now();

  const outcomes = await mapWithConcurrency(
    Array.from({ length: options.requests }, (_, i) => i),
    options.concurrency,
    async (): Promise<RequestOutcome> => {
      const requestStart = deps.now();
      try {
        const res = await deps.fetch(`${options.url}/eligibility/check`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(options.apiKey ? { "x-api-key": options.apiKey } : {})
          },
          body: JSON.stringify({ repo: options.repo })
        });
        // Drain the body so the connection is released before the next
        // request reuses it; an undrained response can stall the pool.
        await res.text();
        return { status: res.status, durationMs: deps.now() - requestStart };
      } catch (err) {
        return {
          status: 0,
          durationMs: deps.now() - requestStart,
          error: (err as Error).message
        };
      }
    }
  );

  const wallClockMs = deps.now() - start;
  const after = await readMetrics(options, deps);

  return {
    ...summarizeOutcomes(outcomes, options, wallClockMs),
    ...(metricsDelta(before, after) ? { metricsDelta: metricsDelta(before, after) } : {})
  };
}

export function formatReport(report: LoadTestReport): string {
  const lines = [
    `requests:     ${report.requests} at concurrency ${report.concurrency}`,
    `wall clock:   ${report.wallClockMs}ms (${report.requestsPerSecond} req/s)`,
    `status:       ${Object.entries(report.byStatus)
      .map(([status, count]) => `${status}=${count}`)
      .join("  ")}`,
    `rate limited: ${report.rateLimited}`,
    `failed:       ${report.failed}`,
    `latency ms:   min=${report.latency.minMs} avg=${report.latency.avgMs} ` +
      `p50=${report.latency.p50Ms} p95=${report.latency.p95Ms} p99=${report.latency.p99Ms} ` +
      `max=${report.latency.maxMs}`
  ];

  if (report.metricsDelta) {
    const d = report.metricsDelta;
    lines.push(
      `service side: evaluations=${d.evaluations} cacheHits=${d.cacheHits} ` +
        `cacheMisses=${d.cacheMisses} cacheErrors=${d.cacheErrors}`,
      `              (evaluations well below requests means the cache and ` +
        `in-flight coalescing are doing their job)`
    );
  }

  return lines.join("\n");
}
