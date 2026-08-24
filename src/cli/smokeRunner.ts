export interface SmokeCheck {
  name: string;
  ok: boolean;
  /** What was observed - the failure reason, or a one-line summary. */
  detail: string;
  durationMs: number;
}

export interface SmokeReport {
  baseUrl: string;
  passed: boolean;
  checks: SmokeCheck[];
}

export interface SmokeOptions {
  baseUrl: string;
  /** Public repos to evaluate end-to-end. */
  repos: string[];
  apiKey?: string;
  fetch: typeof globalThis.fetch;
  now?: () => number;
}

/**
 * One repo per implemented forge, deliberately.
 *
 * A smoke test that only ever exercises GitHub would pass on a deployment
 * where another forge's path is broken in exactly the ways a smoke test
 * exists to catch: no outbound route to that host, a token that expired, a
 * proxy that rewrites the API host. The GitHub repos stay small and
 * stable; the GitLab and Bitbucket ones are real, actively developed
 * public projects for the same reason.
 *
 * The Bitbucket entry earns its place twice over, because that path costs
 * the most to get wrong: its API lives on a different host than its clone
 * URLs, so a deployment can reach bitbucket.org to clone and still fail
 * every API call.
 */
export const DEFAULT_SMOKE_REPOS = [
  "octocat/Hello-World",
  "expressjs/express",
  "https://gitlab.com/gitlab-org/cli",
  "https://bitbucket.org/atlassian/aui"
];

interface Attempt {
  status: number;
  body: unknown;
}

/**
 * A smoke test asks "is this deployment actually working", which is not
 * the same question the unit and integration suites answer. Those run
 * against fakes by design - no network, no clone, no GitHub - so every
 * one of them can pass while the deployed service has no git binary, no
 * outbound network, an unreadable database, or a token that expired.
 *
 * So this drives a *running* instance over HTTP, against real public
 * repos, and checks the shape of what comes back rather than the verdict:
 * whether octocat/Hello-World is eligible today is GitHub's business and
 * the thresholds', and a smoke test that asserts a verdict starts failing
 * for reasons that have nothing to do with the deployment being healthy.
 */
export async function runSmokeTest(options: SmokeOptions): Promise<SmokeReport> {
  const { baseUrl, repos, apiKey, fetch, now = () => Date.now() } = options;
  const root = baseUrl.replace(/\/$/, "");
  const checks: SmokeCheck[] = [];

  async function check(name: string, run: () => Promise<string>): Promise<void> {
    const start = now();
    try {
      const detail = await run();
      checks.push({ name, ok: true, detail, durationMs: now() - start });
    } catch (err) {
      checks.push({ name, ok: false, detail: (err as Error).message, durationMs: now() - start });
    }
  }

  async function call(path: string, init?: RequestInit): Promise<Attempt> {
    const response = await fetch(`${root}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { "x-api-key": apiKey } : {}),
        ...init?.headers
      }
    });
    // Every endpoint answers JSON, including its errors - a body that
    // won't parse is itself a finding worth reporting as one.
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new Error(`${path} did not return JSON (status ${response.status})`);
    }
    return { status: response.status, body };
  }

  await check("liveness", async () => {
    const { status, body } = await call("/health");
    const health = body as { status?: string; version?: string };
    if (status !== 200) throw new Error(`GET /health returned ${status}`);
    if (health.status !== "ok") throw new Error(`GET /health reports "${health.status}"`);
    return `version ${health.version}`;
  });

  await check("readiness", async () => {
    const { status, body } = await call("/ready");
    const report = body as { ready?: boolean; checks?: Record<string, { error?: string }> };
    if (status !== 200 || !report.ready) {
      const failed = Object.entries(report.checks ?? {})
        .filter(([, dependency]) => dependency.error)
        .map(([name, dependency]) => `${name}: ${dependency.error}`)
        .join("; ");
      throw new Error(`GET /ready returned ${status}${failed ? ` (${failed})` : ""}`);
    }
    return "dependencies usable";
  });

  await check("spec", async () => {
    const { status, body } = await call("/openapi.json");
    const spec = body as { openapi?: string; paths?: Record<string, unknown> };
    if (status !== 200) throw new Error(`GET /openapi.json returned ${status}`);
    if (!spec.openapi) throw new Error("GET /openapi.json returned no spec");
    return `${Object.keys(spec.paths ?? {}).length} documented paths`;
  });

  for (const repo of repos) {
    await check(`eligibility: ${repo}`, async () => {
      const { status, body } = await call("/eligibility/check", {
        method: "POST",
        body: JSON.stringify({ repo })
      });
      if (status !== 200) {
        throw new Error(`returned ${status}: ${(body as { error?: string }).error ?? "no error"}`);
      }
      return describeResult(body);
    });
  }

  await check("rejects an unusable reference", async () => {
    // Proves the request actually reached the routes rather than a proxy
    // answering 200 for everything.
    const { status } = await call("/eligibility/check", {
      method: "POST",
      body: JSON.stringify({ repo: "not a repo at all" })
    });
    if (status !== 400) throw new Error(`expected 400 for an unparseable repo, got ${status}`);
    return "400 as expected";
  });

  await check("audit trail", async () => {
    const { status, body } = await call("/admin/evaluations?limit=1");
    if (status !== 200) throw new Error(`GET /admin/evaluations returned ${status}`);
    const { evaluations } = body as { evaluations?: unknown[] };
    if (!Array.isArray(evaluations)) throw new Error("no evaluations array in the response");
    // The checks above just performed evaluations, so an empty trail here
    // means writes aren't landing.
    if (evaluations.length === 0) throw new Error("the trail is empty after evaluating a repo");
    return "recording evaluations";
  });

  return { baseUrl: root, passed: checks.every((c) => c.ok), checks };
}

/**
 * Reports what came back without asserting a verdict: which checks ran and
 * whether the repo passed today, as information rather than as a
 * pass/fail condition.
 */
function describeResult(body: unknown): string {
  const result = body as {
    eligible?: boolean;
    checks?: Record<string, { passed?: boolean }>;
    reasons?: string[];
  };

  if (typeof result.eligible !== "boolean") throw new Error("no `eligible` in the response");

  const expected = ["language", "size", "history", "activeDevelopment"];
  const missing = expected.filter((name) => !result.checks?.[name]);
  if (missing.length > 0) throw new Error(`response is missing checks: ${missing.join(", ")}`);
  if (!Array.isArray(result.reasons)) throw new Error("no `reasons` array in the response");

  const failed = expected.filter((name) => result.checks?.[name]?.passed === false);
  return result.eligible ? "eligible" : `not eligible (${failed.join(", ") || "no failed check"})`;
}

export function formatSmokeReport(report: SmokeReport): string {
  const lines = [`Smoke test against ${report.baseUrl}`, ""];
  for (const check of report.checks) {
    lines.push(
      `${check.ok ? "PASS" : "FAIL"}  ${check.name} (${Math.round(check.durationMs)}ms)\n      ${check.detail}`
    );
  }
  const failed = report.checks.filter((check) => !check.ok).length;
  lines.push("", failed === 0 ? "All checks passed." : `${failed} check(s) failed.`);
  return lines.join("\n");
}
