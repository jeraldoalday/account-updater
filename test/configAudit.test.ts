import { describe, expect, it } from "vitest";
import {
  auditConfig,
  formatFindings,
  hasBlockingFindings,
  type AuditableConfig
} from "../src/health/configAudit";

/** A configuration with nothing wrong with it, for one rule at a time. */
function productionConfig(overrides: Partial<AuditableConfig> = {}): AuditableConfig {
  return {
    apiKey: "secret",
    githubToken: "ghp_x",
    gitlabToken: "glpat_x",
    bitbucketToken: "bbat_x",
    cacheBackend: "redis",
    cacheTtlMs: 600_000,
    historyDbPath: "/var/lib/account-updater/history.db",
    historyRetentionDays: 90,
    rateLimitMax: 20,
    rateLimitWindowMs: 60_000,
    circuitBreakerFailureThreshold: 5,
    circuitBreakerOpenMs: 30_000,
    shutdownDrainMs: 5_000,
    ...overrides
  };
}

function ids(config: AuditableConfig): string[] {
  return auditConfig(config).map((finding) => finding.id);
}

describe("auditConfig", () => {
  it("finds nothing to say about a well-configured deployment", () => {
    expect(auditConfig(productionConfig())).toEqual([]);
  });

  it("calls out an unauthenticated endpoint that clones arbitrary repos", () => {
    const [finding] = auditConfig(productionConfig({ apiKey: undefined }));

    expect(finding.id).toBe("no-api-key");
    expect(finding.severity).toBe("critical");
    expect(finding.remedy).toContain("API_KEY");
  });

  it("calls out having no GitHub credential at all", () => {
    // 60 requests an hour, shared across every repo checked - the service
    // works in testing and then stops working under any real load.
    const findings = auditConfig(
      productionConfig({ githubToken: undefined, githubAppAuthConfig: undefined })
    );

    expect(findings.map((f) => f.id)).toContain("no-github-credential");
    expect(findings[0].severity).toBe("critical");
  });

  it("calls out a missing GitLab credential as a warning, not a blocker", () => {
    // Unlike the GitHub case, a deployment can legitimately never see a
    // GitLab repo - so this is worth saying and not worth refusing to
    // ship over.
    const findings = auditConfig(productionConfig({ gitlabToken: undefined }));
    const finding = findings.find((f) => f.id === "no-gitlab-credential");

    expect(finding?.severity).toBe("warning");
    expect(finding?.remedy).toContain("read_api");
    expect(hasBlockingFindings(findings)).toBe(false);
  });

  it("calls out a missing Bitbucket credential as a warning, not a blocker", () => {
    const findings = auditConfig(productionConfig({ bitbucketToken: undefined }));
    const finding = findings.find((f) => f.id === "no-bitbucket-credential");

    expect(finding?.severity).toBe("warning");
    expect(finding?.remedy).toContain("repository:read");
    expect(hasBlockingFindings(findings)).toBe(false);
  });

  it("says something about every forge whose credential can be missing", () => {
    // A forge implemented without a matching finding here means a
    // deployment that will throttle and fail on it gets no warning at all,
    // which is the failure this audit exists to prevent.
    const findings = ids(
      productionConfig({
        githubToken: undefined,
        gitlabToken: undefined,
        bitbucketToken: undefined
      })
    );

    expect(findings).toContain("no-github-credential");
    expect(findings).toContain("no-gitlab-credential");
    expect(findings).toContain("no-bitbucket-credential");
  });

  it("accepts a GitHub App installation in place of a token", () => {
    const findings = ids(
      productionConfig({ githubToken: undefined, githubAppAuthConfig: { appId: "1" } })
    );

    expect(findings).not.toContain("no-github-credential");
  });

  it("warns that a per-process cache leaves every new instance cold", () => {
    expect(ids(productionConfig({ cacheBackend: "memory" }))).toContain("per-process-cache");
  });

  it("warns when the audit trail is written somewhere the host will clear", () => {
    expect(ids(productionConfig({ historyDbPath: "/tmp/history.db" }))).toContain(
      "audit-trail-in-temp"
    );
  });

  it("notes a relative audit-trail path, which depends on the working directory", () => {
    expect(ids(productionConfig({ historyDbPath: "./data/history.db" }))).toContain(
      "audit-trail-relative-path"
    );
  });

  it("doesn't report a relative path as also being in a temp directory", () => {
    const findings = ids(productionConfig({ historyDbPath: "/tmp/history.db" }));
    expect(findings).not.toContain("audit-trail-relative-path");
  });

  it("warns when retention is off, since the trail then grows forever", () => {
    expect(ids(productionConfig({ historyRetentionDays: 0 }))).toContain("retention-disabled");
  });

  it("warns when shutdown has no drain window", () => {
    expect(ids(productionConfig({ shutdownDrainMs: 0 }))).toContain("no-drain-window");
  });

  it("warns about a rate limit that allows more clones than a host will like", () => {
    expect(ids(productionConfig({ rateLimitMax: 500, rateLimitWindowMs: 60_000 }))).toContain(
      "high-rate-limit"
    );
  });

  it("judges the rate limit by rate, not by the raw maximum", () => {
    // 500 per hour is not 500 per minute; a wide window is the point.
    expect(
      ids(productionConfig({ rateLimitMax: 500, rateLimitWindowMs: 3_600_000 }))
    ).not.toContain("high-rate-limit");
  });

  it("notes a cache TTL too short to cache anything useful", () => {
    expect(ids(productionConfig({ cacheTtlMs: 1_000 }))).toContain("short-cache-ttl");
  });

  it("reports every problem at once, rather than the first one", () => {
    const findings = ids(
      productionConfig({ apiKey: undefined, githubToken: undefined, cacheBackend: "memory" })
    );

    expect(findings).toEqual(
      expect.arrayContaining(["no-api-key", "no-github-credential", "per-process-cache"])
    );
  });
});

describe("hasBlockingFindings", () => {
  it("blocks on a critical finding", () => {
    expect(hasBlockingFindings(auditConfig(productionConfig({ apiKey: undefined })))).toBe(true);
  });

  it("does not block on warnings alone", () => {
    // Several warnings are legitimate choices for a single-instance
    // deployment, so a pipeline gating on this must not trip over them.
    expect(hasBlockingFindings(auditConfig(productionConfig({ cacheBackend: "memory" })))).toBe(
      false
    );
  });

  it("does not block on a clean config", () => {
    expect(hasBlockingFindings([])).toBe(false);
  });
});

describe("formatFindings", () => {
  it("says so plainly when there is nothing to report", () => {
    expect(formatFindings([])).toBe("No configuration problems found.");
  });

  it("puts critical findings first, whatever order they were produced in", () => {
    const text = formatFindings([
      { severity: "info", id: "b", message: "m", remedy: "r" },
      { severity: "critical", id: "a", message: "m", remedy: "r" }
    ]);

    expect(text.indexOf("[CRITICAL]")).toBeLessThan(text.indexOf("[INFO]"));
  });

  it("prints the remedy alongside the problem", () => {
    const text = formatFindings([
      { severity: "warning", id: "x", message: "something is off", remedy: "do this" }
    ]);

    expect(text).toContain("something is off");
    expect(text).toContain("do this");
  });
});

describe("auditConfig and the settings that changed meaning", () => {
  // The rate limit is counted in repos, so a limit under the batch cap is
  // not a tight limit - it is an endpoint that cannot be used at its
  // documented size at all, however long the caller waits.
  it("warns when the rate limit is below the size of a batch it accepts", () => {
    const findings = auditConfig(productionConfig({ rateLimitMax: 10 }));
    const finding = findings.find((f) => f.id === "rate-limit-below-batch-size");

    expect(finding?.severity).toBe("warning");
    expect(finding?.message).toContain("20 repos");
  });

  it("says nothing when the limit can cover a full batch", () => {
    expect(ids(productionConfig({ rateLimitMax: 20 }))).not.toContain(
      "rate-limit-below-batch-size"
    );
  });

  it("keeps the batch cap it warns about in step with the route's own", async () => {
    // Duplicated rather than imported, to keep this module checkable
    // without pulling in the evaluation path. Asserted equal here so the
    // duplication cannot drift into a warning about the wrong number.
    const { MAX_BATCH_SIZE } = await import("../src/routes/eligibility.route");
    const finding = auditConfig(productionConfig({ rateLimitMax: 1 })).find(
      (f) => f.id === "rate-limit-below-batch-size"
    );

    expect(finding?.message).toContain(`${MAX_BATCH_SIZE} repos`);
  });

  it("warns when one blip is enough to cut a forge off", () => {
    const finding = auditConfig(productionConfig({ circuitBreakerFailureThreshold: 1 })).find(
      (f) => f.id === "trigger-happy-circuit-breaker"
    );

    expect(finding?.severity).toBe("warning");
  });

  it("accepts a threshold that needs a real run of failures", () => {
    expect(ids(productionConfig({ circuitBreakerFailureThreshold: 3 }))).not.toContain(
      "trigger-happy-circuit-breaker"
    );
  });

  it("notes a cooldown long enough to outlast the outage it reacted to", () => {
    const finding = auditConfig(productionConfig({ circuitBreakerOpenMs: 600_000 })).find(
      (f) => f.id === "slow-circuit-recovery"
    );

    expect(finding?.severity).toBe("info");
  });

  it("says nothing about a cooldown measured in seconds", () => {
    expect(ids(productionConfig({ circuitBreakerOpenMs: 30_000 }))).not.toContain(
      "slow-circuit-recovery"
    );
  });
});
