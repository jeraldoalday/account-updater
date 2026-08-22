import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseRepoRef } from "../src/utils/repoUrl";
import { supportedProviderIds } from "../src/providers/registry";
import {
  DEFAULT_SMOKE_REPOS,
  formatSmokeReport,
  runSmokeTest,
  type SmokeReport
} from "../src/cli/smokeRunner";

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    json: async () => body
  } as unknown as Response;
}

/**
 * A service that answers everything correctly, with per-path overrides so
 * each test can break exactly one thing.
 */
function fakeService(overrides: Record<string, Response> = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];

  const defaults: Record<string, Response> = {
    "/health": jsonResponse(200, { status: "ok", version: "1.0.0", uptimeSeconds: 5 }),
    "/ready": jsonResponse(200, {
      ready: true,
      draining: false,
      checks: { cache: { ok: true }, history: { ok: true } }
    }),
    "/openapi.json": jsonResponse(200, { openapi: "3.0.3", paths: { "/health": {} } }),
    "/eligibility/check": jsonResponse(200, {
      eligible: true,
      repo: { provider: "github", owner: "octocat", repo: "Hello-World" },
      checks: {
        language: { passed: true },
        size: { passed: true },
        history: { passed: true },
        activeDevelopment: { passed: true }
      },
      reasons: []
    }),
    "/admin/evaluations?limit=1": jsonResponse(200, { evaluations: [{ id: 1 }] })
  };

  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const path = url.replace("http://svc", "");
    const body = init?.body ? (JSON.parse(String(init.body)) as { repo?: string }) : undefined;

    // An unparseable repo is expected to be rejected; the fake has to
    // behave like the real routes for that to mean anything.
    if (path === "/eligibility/check" && body?.repo === "not a repo at all") {
      return overrides["/eligibility/check:bad"] ?? jsonResponse(400, { error: "unparseable" });
    }

    return overrides[path] ?? defaults[path] ?? jsonResponse(404, { error: "no route" });
  }) as unknown as typeof globalThis.fetch;

  return { fetch: fetchImpl, calls };
}

async function run(overrides: Record<string, Response> = {}, repos = ["octocat/Hello-World"]) {
  const service = fakeService(overrides);
  const report = await runSmokeTest({
    baseUrl: "http://svc",
    repos,
    fetch: service.fetch,
    now: (() => {
      let t = 0;
      return () => (t += 10);
    })()
  });
  return { report, calls: service.calls };
}

function check(report: SmokeReport, name: string) {
  const found = report.checks.find((c) => c.name === name);
  if (!found) throw new Error(`no check named ${name} in ${report.checks.map((c) => c.name)}`);
  return found;
}

describe("runSmokeTest", () => {
  it("passes against a healthy service", async () => {
    const { report } = await run();

    expect(report.passed).toBe(true);
    expect(report.checks.every((c) => c.ok)).toBe(true);
  });

  it("reports every check, not just the first failure", async () => {
    const { report } = await run({ "/health": jsonResponse(500, { error: "boom" }) });

    expect(report.passed).toBe(false);
    expect(report.checks.length).toBeGreaterThan(4);
    expect(check(report, "readiness").ok).toBe(true);
  });

  it("fails when the instance reports itself unready, naming the dependency", async () => {
    const { report } = await run({
      "/ready": jsonResponse(503, {
        ready: false,
        checks: { cache: { ok: false, error: "redis is gone" }, history: { ok: true } }
      })
    });

    expect(check(report, "readiness").ok).toBe(false);
    expect(check(report, "readiness").detail).toContain("redis is gone");
  });

  it("fails when an eligibility check errors upstream", async () => {
    const { report } = await run({
      "/eligibility/check": jsonResponse(502, { error: "git clone failed" })
    });

    const result = check(report, "eligibility: octocat/Hello-World");
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("git clone failed");
  });

  it("accepts an ineligible repo: the shape is the assertion, not the verdict", async () => {
    // Whether a real public repo passes today is GitHub's business and the
    // thresholds'; asserting a verdict would make this fail for reasons
    // that say nothing about the deployment.
    const { report } = await run({
      "/eligibility/check": jsonResponse(200, {
        eligible: false,
        checks: {
          language: { passed: true },
          size: { passed: false },
          history: { passed: true },
          activeDevelopment: { passed: true }
        },
        reasons: ["too small"]
      })
    });

    const result = check(report, "eligibility: octocat/Hello-World");
    expect(result.ok).toBe(true);
    expect(result.detail).toContain("not eligible (size)");
  });

  it("fails when a result is missing checks the API promises", async () => {
    const { report } = await run({
      "/eligibility/check": jsonResponse(200, {
        eligible: true,
        checks: { language: { passed: true } },
        reasons: []
      })
    });

    expect(check(report, "eligibility: octocat/Hello-World").detail).toContain(
      "missing checks: size, history, activeDevelopment"
    );
  });

  it("fails when a bad reference is accepted instead of rejected", async () => {
    // A proxy answering 200 for everything would sail through the rest.
    const { report } = await run({
      "/eligibility/check:bad": jsonResponse(200, { eligible: true })
    });

    expect(check(report, "rejects an unusable reference").ok).toBe(false);
  });

  it("fails when the audit trail has nothing in it after an evaluation", async () => {
    const { report } = await run({
      "/admin/evaluations?limit=1": jsonResponse(200, { evaluations: [] })
    });

    expect(check(report, "audit trail").ok).toBe(false);
    expect(check(report, "audit trail").detail).toContain("empty");
  });

  it("reports a non-JSON response as a finding rather than crashing", async () => {
    const notJson = {
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token <");
      }
    } as unknown as Response;

    const { report } = await run({ "/health": notJson });

    expect(check(report, "liveness").ok).toBe(false);
    expect(check(report, "liveness").detail).toContain("did not return JSON");
  });

  it("checks every repo it was given", async () => {
    const { report } = await run({}, ["a/one", "b/two"]);

    expect(check(report, "eligibility: a/one").ok).toBe(true);
    expect(check(report, "eligibility: b/two").ok).toBe(true);
  });

  it("sends the API key when it has one", async () => {
    const service = fakeService();
    await runSmokeTest({
      baseUrl: "http://svc",
      repos: [],
      apiKey: "secret",
      fetch: service.fetch
    });

    const headers = service.calls[0].init?.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("secret");
  });

  it("tolerates a base URL with a trailing slash", async () => {
    const service = fakeService();
    const report = await runSmokeTest({
      baseUrl: "http://svc/",
      repos: [],
      fetch: service.fetch
    });

    expect(service.calls[0].url).toBe("http://svc/health");
    expect(report.baseUrl).toBe("http://svc");
  });

  it("times each check", async () => {
    const { report } = await run();
    expect(report.checks.every((c) => c.durationMs >= 0)).toBe(true);
  });

  it("ships with real public repos to check by default", () => {
    expect(DEFAULT_SMOKE_REPOS.length).toBeGreaterThan(0);
    for (const repo of DEFAULT_SMOKE_REPOS) {
      // Every default has to be something parseRepoRef accepts, or the
      // smoke run fails on its own inputs rather than on the deployment.
      expect(() => parseRepoRef(repo)).not.toThrow();
    }
  });

  it("covers every implemented forge by default", () => {
    // The point of a smoke test is the paths the offline suites cannot
    // reach. A default set that only names GitHub repos would pass on a
    // deployment with no route to gitlab.com, an expired GITLAB_TOKEN, or
    // a proxy that rewrites the API host.
    const covered = new Set(DEFAULT_SMOKE_REPOS.map((repo) => parseRepoRef(repo).provider));
    expect([...covered].sort()).toEqual([...supportedProviderIds()].sort());
  });
});

describe("formatSmokeReport", () => {
  it("marks each check and summarizes the run", async () => {
    const { report } = await run();
    const text = formatSmokeReport(report);

    expect(text).toContain("Smoke test against http://svc");
    expect(text).toContain("PASS  liveness");
    expect(text).toContain("All checks passed.");
  });

  it("counts the failures when there are any", async () => {
    const { report } = await run({ "/health": jsonResponse(500, {}) });
    const text = formatSmokeReport(report);

    expect(text).toContain("FAIL  liveness");
    expect(text).toContain("1 check(s) failed.");
  });
});

describe("smoke CLI wiring", () => {
  it("is registered as an npm script, so the check is one command", () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.smoke).toContain("smoke.js");
  });
});
