import { describe, expect, it, vi } from "vitest";
import {
  LoadTestArgumentError,
  formatReport,
  parseLoadTestArgs,
  percentile,
  runLoadTest,
  summarizeLatency,
  summarizeOutcomes,
  type LoadTestOptions
} from "../src/cli/loadTestRunner";

const baseOptions: LoadTestOptions = {
  url: "http://service.test",
  repo: "acme/widgets",
  requests: 4,
  concurrency: 2
};

describe("parseLoadTestArgs", () => {
  it("requires a repo", () => {
    expect(() => parseLoadTestArgs([])).toThrow(LoadTestArgumentError);
    expect(() => parseLoadTestArgs([])).toThrow(/--repo is required/);
  });

  it("applies defaults for everything but the repo", () => {
    expect(parseLoadTestArgs(["--repo", "acme/widgets"])).toEqual({
      url: "http://localhost:3000",
      repo: "acme/widgets",
      requests: 50,
      concurrency: 10,
      apiKey: undefined
    });
  });

  it("reads every supported flag", () => {
    const options = parseLoadTestArgs([
      "--repo",
      "acme/widgets",
      "--url",
      "https://checks.test",
      "--requests",
      "200",
      "--concurrency",
      "25",
      "--api-key",
      "secret"
    ]);

    expect(options).toEqual({
      url: "https://checks.test",
      repo: "acme/widgets",
      requests: 200,
      concurrency: 25,
      apiKey: "secret"
    });
  });

  it("strips a trailing slash so request URLs don't end up doubled", () => {
    expect(parseLoadTestArgs(["--repo", "a/b", "--url", "http://x.test/"]).url).toBe(
      "http://x.test"
    );
  });

  it("rejects counts that aren't positive integers", () => {
    const cases = [
      ["--requests", "0"],
      ["--requests", "-5"],
      ["--concurrency", "abc"],
      ["--concurrency", "2.5"]
    ];
    for (const [flag, value] of cases) {
      expect(() => parseLoadTestArgs(["--repo", "a/b", flag, value])).toThrow(
        LoadTestArgumentError
      );
    }
  });

  it("rejects a malformed argument list rather than silently ignoring it", () => {
    expect(() => parseLoadTestArgs(["repo", "a/b"])).toThrow(/Expected a --flag/);
    expect(() => parseLoadTestArgs(["--repo"])).toThrow(/Missing value for --repo/);
  });
});

describe("percentile", () => {
  it("uses nearest-rank rather than interpolating between samples", () => {
    const sorted = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(sorted, 50)).toBe(50);
    expect(percentile(sorted, 95)).toBe(100);
    expect(percentile(sorted, 100)).toBe(100);
  });

  it("is 0 for an empty sample", () => {
    expect(percentile([], 95)).toBe(0);
  });

  it("never reads past the end of the sample", () => {
    expect(percentile([5], 99)).toBe(5);
  });
});

describe("summarizeLatency", () => {
  it("reports min/avg/max and percentiles", () => {
    const stats = summarizeLatency([100, 200, 300, 400]);
    expect(stats.minMs).toBe(100);
    expect(stats.maxMs).toBe(400);
    expect(stats.avgMs).toBe(250);
    expect(stats.p50Ms).toBe(200);
  });

  it("zeroes everything when no requests completed", () => {
    expect(summarizeLatency([])).toEqual({
      minMs: 0,
      avgMs: 0,
      p50Ms: 0,
      p95Ms: 0,
      p99Ms: 0,
      maxMs: 0
    });
  });
});

describe("summarizeOutcomes", () => {
  it("buckets statuses and counts rate-limited and failed requests separately", () => {
    const report = summarizeOutcomes(
      [
        { status: 200, durationMs: 10 },
        { status: 200, durationMs: 20 },
        { status: 429, durationMs: 1 },
        { status: 0, durationMs: 5, error: "ECONNREFUSED" }
      ],
      baseOptions,
      1000
    );

    expect(report.byStatus).toEqual({ "200": 2, "429": 1, error: 1 });
    expect(report.rateLimited).toBe(1);
    expect(report.failed).toBe(1);
    expect(report.requestsPerSecond).toBe(4);
  });
});

describe("runLoadTest", () => {
  function fakeClock() {
    let time = 0;
    return () => (time += 10);
  }

  it("sends the configured number of requests and reports what came back", async () => {
    const fetch = vi.fn(async (url: string) => {
      if (String(url).endsWith("/metrics")) {
        return new Response(JSON.stringify({ eligibilityChecksTotal: 0, cacheHits: 0 }), {
          status: 200
        });
      }
      return new Response("{}", { status: 200 });
    });

    const report = await runLoadTest(baseOptions, {
      fetch: fetch as unknown as typeof globalThis.fetch,
      now: fakeClock()
    });

    const checkCalls = fetch.mock.calls.filter(([url]) =>
      String(url).endsWith("/eligibility/check")
    );
    expect(checkCalls).toHaveLength(4);
    expect(report.requests).toBe(4);
    expect(report.byStatus).toEqual({ "200": 4 });
    expect(report.failed).toBe(0);
  });

  it("sends the api key header only when one is configured", async () => {
    const fetch = vi.fn(
      async (_url: string, _init?: RequestInit) => new Response("{}", { status: 200 })
    );
    await runLoadTest(
      { ...baseOptions, requests: 1, apiKey: "secret" },
      {
        fetch: fetch as unknown as typeof globalThis.fetch,
        now: fakeClock()
      }
    );

    const checkCall = fetch.mock.calls.find(([url]) => String(url).endsWith("/eligibility/check"));
    const headers = (checkCall?.[1] as unknown as { headers: Record<string, string> }).headers;
    expect(headers["x-api-key"]).toBe("secret");
  });

  it("records a connection failure as a failed request instead of aborting the run", async () => {
    const fetch = vi.fn(async (url: string) => {
      if (String(url).endsWith("/eligibility/check")) throw new Error("ECONNREFUSED");
      return new Response("{}", { status: 200 });
    });

    const report = await runLoadTest(
      { ...baseOptions, requests: 3 },
      {
        fetch: fetch as unknown as typeof globalThis.fetch,
        now: fakeClock()
      }
    );

    expect(report.failed).toBe(3);
    expect(report.byStatus).toEqual({ error: 3 });
  });

  it("reports how much work the service actually did, from the metrics delta", async () => {
    // The whole point of hammering one repo: many requests, few evaluations.
    let metricsCall = 0;
    const fetch = vi.fn(async (url: string) => {
      if (String(url).endsWith("/metrics")) {
        metricsCall++;
        const body =
          metricsCall === 1
            ? { eligibilityChecksTotal: 5, cacheHits: 2, cacheMisses: 5, cacheErrors: 0 }
            : { eligibilityChecksTotal: 6, cacheHits: 5, cacheMisses: 6, cacheErrors: 1 };
        return new Response(JSON.stringify(body), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });

    const report = await runLoadTest(baseOptions, {
      fetch: fetch as unknown as typeof globalThis.fetch,
      now: fakeClock()
    });

    expect(report.metricsDelta).toEqual({
      evaluations: 1,
      cacheHits: 3,
      cacheMisses: 1,
      cacheErrors: 1
    });
  });

  it("still reports load numbers when /metrics is unavailable", async () => {
    const fetch = vi.fn(async (url: string) => {
      if (String(url).endsWith("/metrics")) return new Response("nope", { status: 404 });
      return new Response("{}", { status: 200 });
    });

    const report = await runLoadTest(baseOptions, {
      fetch: fetch as unknown as typeof globalThis.fetch,
      now: fakeClock()
    });

    expect(report.metricsDelta).toBeUndefined();
    expect(report.requests).toBe(4);
  });
});

describe("formatReport", () => {
  it("renders the service-side line only when metrics were available", () => {
    const report = summarizeOutcomes([{ status: 200, durationMs: 10 }], baseOptions, 100);

    expect(formatReport(report)).not.toContain("service side");
    expect(
      formatReport({
        ...report,
        metricsDelta: { evaluations: 1, cacheHits: 9, cacheMisses: 1, cacheErrors: 0 }
      })
    ).toContain("evaluations=1");
  });
});
