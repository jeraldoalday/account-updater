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
      checks: { cache: { ok: true }, history: { ok: true } },
      providerCircuits: {
        github: { name: "GitHub", state: "closed", consecutiveFailures: 0 },
        gitlab: { name: "GitLab", state: "closed", consecutiveFailures: 0 },
        bitbucket: { name: "Bitbucket", state: "closed", consecutiveFailures: 0 }
      }
    }),
    "/rules": jsonResponse(200, {
      fingerprint: "3f1c0a9b2d4e5f60",
      version: "1.3.0",
      languages: { known: ["TypeScript", "Go"], eligible: ["TypeScript"] },
      thresholds: { minLines: 8000, minCommits: 140 }
    }),
    "/openapi.json": jsonResponse(200, { openapi: "3.0.3", paths: { "/health": {} } }),
    "/providers": jsonResponse(200, {
      providers: supportedProviderIds().map((id) => ({ id, supported: true }))
    }),
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

  it("reports which forges the deployed instance evaluates", async () => {
    const { report } = await run();

    const providers = check(report, "providers");
    expect(providers.ok).toBe(true);
    for (const id of supportedProviderIds()) {
      expect(providers.detail).toContain(id);
    }
  });

  it("fails when the instance cannot evaluate a forge this run is about to check", async () => {
    // The deployed build is the authority on what it supports, and this
    // CLI can be newer than it. Without this, a default repo on a forge the
    // instance doesn't implement shows up as a mysterious 400 from the
    // eligibility check rather than as "that instance is older than you
    // think".
    const { report } = await run(
      {
        "/providers": jsonResponse(200, {
          providers: [
            { id: "github", supported: true },
            { id: "gitlab", supported: false },
            { id: "bitbucket", supported: false }
          ]
        })
      },
      ["octocat/Hello-World", "https://gitlab.com/acme/widgets"]
    );

    const providers = check(report, "providers");
    expect(providers.ok).toBe(false);
    expect(providers.detail).toContain("gitlab.com/acme/widgets");
    // The forge that does work is not a finding.
    expect(providers.detail).not.toContain("Hello-World");
  });

  it("fails when the instance lists no forges at all", async () => {
    const { report } = await run({ "/providers": jsonResponse(200, { providers: [] }) });

    expect(check(report, "providers").ok).toBe(false);
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

describe("runSmokeTest against the rule set a deployment is enforcing", () => {
  // "The repo that used to pass doesn't" has two explanations - the repo
  // changed, or the bar did - and nothing else in this output can tell
  // them apart. A retuned threshold is invisible everywhere else.
  it("reports the fingerprint and the languages in force", async () => {
    const { report } = await run();

    expect(check(report, "rules").ok).toBe(true);
    expect(check(report, "rules").detail).toContain("3f1c0a9b2d4e5f60");
    expect(check(report, "rules").detail).toContain("TypeScript");
  });

  it("fails when the instance publishes no thresholds", async () => {
    const { report } = await run({ "/rules": jsonResponse(200, { fingerprint: "abc" }) });

    expect(check(report, "rules").ok).toBe(false);
    expect(report.passed).toBe(false);
  });

  it("fails when /rules is not served at all", async () => {
    const { report } = await run({ "/rules": jsonResponse(404, { error: "no route" }) });

    expect(check(report, "rules").ok).toBe(false);
  });
});

describe("runSmokeTest against a forge this instance has given up on", () => {
  function readyWithCircuits(circuits: Record<string, unknown>): Response {
    return jsonResponse(200, {
      ready: true,
      draining: false,
      checks: { cache: { ok: true }, history: { ok: true } },
      providerCircuits: circuits
    });
  }

  it("passes when every forge is answering", async () => {
    const { report } = await run();

    expect(check(report, "provider circuits").ok).toBe(true);
    expect(check(report, "provider circuits").detail).toContain("3 forge(s)");
  });

  // Without this, an eligibility check failing against one forge is a
  // mysterious 503. With it, the report says which forge was given up on
  // and what the error that did it was.
  it("names the forge and the failure behind an open circuit", async () => {
    const { report } = await run({
      "/ready": readyWithCircuits({
        github: { name: "GitHub", state: "closed", consecutiveFailures: 0 },
        bitbucket: {
          name: "Bitbucket",
          state: "open",
          consecutiveFailures: 5,
          lastError: "500 from api.bitbucket.org"
        }
      })
    });

    const circuits = check(report, "provider circuits");
    expect(circuits.ok).toBe(false);
    expect(circuits.detail).toContain("bitbucket");
    expect(circuits.detail).toContain("500 from api.bitbucket.org");
  });

  it("treats a half-open circuit as worth reporting too", async () => {
    const { report } = await run({
      "/ready": readyWithCircuits({
        gitlab: { name: "GitLab", state: "half-open", consecutiveFailures: 5 }
      })
    });

    expect(check(report, "provider circuits").ok).toBe(false);
  });

  // A smoke test whose job is checking a deployment should not fail it for
  // being an older build than the CLI.
  it("says so, rather than failing, when the build reports no circuits", async () => {
    const { report } = await run({
      "/ready": jsonResponse(200, {
        ready: true,
        draining: false,
        checks: { cache: { ok: true }, history: { ok: true } }
      })
    });

    const circuits = check(report, "provider circuits");
    expect(circuits.ok).toBe(true);
    expect(circuits.detail).toContain("not reported");
  });

  // A breaker opens because calls failed, so asking before any call has
  // been made can only ever say "closed".
  it("asks after the evaluations, not before them", async () => {
    const { report } = await run();
    const names = report.checks.map((c) => c.name);

    expect(names.indexOf("provider circuits")).toBeGreaterThan(
      names.findIndex((name) => name.startsWith("eligibility:"))
    );
  });
});
