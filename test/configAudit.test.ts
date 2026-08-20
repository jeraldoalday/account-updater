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
    cacheBackend: "redis",
    cacheTtlMs: 600_000,
    historyDbPath: "/var/lib/account-updater/history.db",
    historyRetentionDays: 90,
    rateLimitMax: 20,
    rateLimitWindowMs: 60_000,
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
