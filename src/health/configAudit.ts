export type FindingSeverity = "critical" | "warning" | "info";

export interface ConfigFinding {
  severity: FindingSeverity;
  /** Stable id, so a deployment can suppress or grep for one finding. */
  id: string;
  message: string;
  /** What to do about it. */
  remedy: string;
}

/**
 * The subset of the service config this audit reasons about. Declared
 * structurally rather than importing `config`, so the rules can be tested
 * against made-up deployments instead of whatever the current environment
 * happens to hold.
 */
export interface AuditableConfig {
  apiKey?: string;
  githubToken?: string;
  githubAppAuthConfig?: unknown;
  gitlabToken?: string;
  cacheBackend: "memory" | "redis";
  cacheTtlMs: number;
  historyDbPath: string;
  historyRetentionDays: number;
  rateLimitMax: number;
  rateLimitWindowMs: number;
  shutdownDrainMs: number;
}

const TEMP_DIRECTORIES = ["/tmp/", "/var/tmp/", "/private/tmp/"];

/**
 * Reviews a running configuration for the settings that are fine on a
 * laptop and wrong in production.
 *
 * Startup validation already rejects a config that can't work at all
 * (a missing REDIS_URL, a half-configured GitHub App). What it can't
 * reject is a config that works perfectly and is still a bad idea to
 * deploy: no API key on an endpoint that clones arbitrary repos, an audit
 * trail written to a path that a container restart erases, unauthenticated
 * GitHub calls that will exhaust 60 requests an hour and then fail every
 * check. Those are judgement calls, not errors, so they belong in a report
 * an operator reads - `npm run doctor`, and a startup log line - rather
 * than in a refusal to boot.
 */
export function auditConfig(config: AuditableConfig): ConfigFinding[] {
  const findings: ConfigFinding[] = [];

  if (!config.apiKey) {
    findings.push({
      severity: "critical",
      id: "no-api-key",
      message:
        "API_KEY is not set, so /eligibility and /admin are open to anyone who can reach this instance.",
      remedy:
        "Set API_KEY (callers send it as x-api-key), or keep the service on a network only trusted callers can reach."
    });
  }

  if (!config.githubToken && !config.githubAppAuthConfig) {
    findings.push({
      severity: "critical",
      id: "no-github-credential",
      message:
        "Neither GITHUB_TOKEN nor a GitHub App installation is configured, so GitHub API calls are unauthenticated (60 requests/hour, shared across every repo checked).",
      remedy:
        "Set GITHUB_TOKEN, or GITHUB_APP_ID/GITHUB_APP_PRIVATE_KEY/GITHUB_APP_INSTALLATION_ID for a higher shared limit."
    });
  }

  // Deliberately a warning where the missing GitHub credential is
  // critical. A deployment can legitimately never see a GitLab repo, in
  // which case this costs nothing - but if it does see one, the failure is
  // the same shape: throttled requests, and private projects invisible.
  if (!config.gitlabToken) {
    findings.push({
      severity: "warning",
      id: "no-gitlab-credential",
      message:
        "GITLAB_TOKEN is not set, so GitLab API calls are unauthenticated (heavily throttled) and private GitLab projects cannot be evaluated at all.",
      remedy:
        "Set GITLAB_TOKEN with read_api scope (plus read_repository to clone private projects), or ignore this if no GitLab repo will ever be checked here."
    });
  }

  if (config.cacheBackend === "memory") {
    findings.push({
      severity: "warning",
      id: "per-process-cache",
      message:
        "CACHE_BACKEND is memory, so each instance caches on its own and every new instance starts cold.",
      remedy:
        "Fine for a single instance. Behind a load balancer, set CACHE_BACKEND=redis with REDIS_URL so instances share results."
    });
  }

  if (TEMP_DIRECTORIES.some((dir) => config.historyDbPath.startsWith(dir))) {
    findings.push({
      severity: "warning",
      id: "audit-trail-in-temp",
      message: `HISTORY_DB_PATH (${config.historyDbPath}) is under a temp directory, so the audit trail is lost whenever the host clears it.`,
      remedy: "Point HISTORY_DB_PATH at a persistent volume."
    });
  } else if (!config.historyDbPath.startsWith("/")) {
    findings.push({
      severity: "info",
      id: "audit-trail-relative-path",
      message: `HISTORY_DB_PATH (${config.historyDbPath}) is relative, so which file gets used depends on the working directory the service was started from.`,
      remedy: "Use an absolute path in a deployed environment."
    });
  }

  if (config.historyRetentionDays === 0) {
    findings.push({
      severity: "warning",
      id: "retention-disabled",
      message:
        "HISTORY_RETENTION_DAYS is 0, so the audit trail is never pruned and grows for as long as the service runs.",
      remedy:
        "Set a retention window, or make sure something else is trimming the database and watching its disk."
    });
  }

  if (config.shutdownDrainMs === 0) {
    findings.push({
      severity: "warning",
      id: "no-drain-window",
      message:
        "SHUTDOWN_DRAIN_MS is 0, so the listener closes as soon as SIGTERM arrives - before a load balancer can see /ready report the instance as draining.",
      remedy: "Set SHUTDOWN_DRAIN_MS to at least one readiness-probe interval."
    });
  }

  // An eligibility check clones a repo and makes several API calls, so a
  // generous limit is a bigger deal here than on a typical read endpoint.
  const requestsPerMinute = (config.rateLimitMax / config.rateLimitWindowMs) * 60_000;
  if (requestsPerMinute > 120) {
    findings.push({
      severity: "warning",
      id: "high-rate-limit",
      message: `The rate limit allows ~${Math.round(requestsPerMinute)} eligibility checks per minute per caller, and each one clones a repo and calls the provider API.`,
      remedy: "Lower RATE_LIMIT_MAX or widen RATE_LIMIT_WINDOW_MS unless the host can take it."
    });
  }

  if (config.cacheTtlMs < 30_000) {
    findings.push({
      severity: "info",
      id: "short-cache-ttl",
      message: `CACHE_TTL_MS is ${config.cacheTtlMs}ms, short enough that most repeat checks will re-clone rather than hit the cache.`,
      remedy: "Raise it unless results really do need to be that fresh."
    });
  }

  return findings;
}

/** Findings serious enough that a deployment should be reconsidered. */
export function hasBlockingFindings(findings: readonly ConfigFinding[]): boolean {
  return findings.some((finding) => finding.severity === "critical");
}

export function formatFindings(findings: readonly ConfigFinding[]): string {
  if (findings.length === 0) {
    return "No configuration problems found.";
  }

  const order: FindingSeverity[] = ["critical", "warning", "info"];
  return [...findings]
    .sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity))
    .map(
      (finding) =>
        `[${finding.severity.toUpperCase()}] ${finding.id}\n  ${finding.message}\n  -> ${finding.remedy}`
    )
    .join("\n\n");
}
