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
  bitbucketToken?: string;
  cacheBackend: "memory" | "redis";
  cacheTtlMs: number;
  historyDbPath: string;
  historyRetentionDays: number;
  rateLimitMax: number;
  rateLimitWindowMs: number;
  circuitBreakerFailureThreshold: number;
  circuitBreakerOpenMs: number;
  shutdownDrainMs: number;
}

const TEMP_DIRECTORIES = ["/tmp/", "/var/tmp/", "/private/tmp/"];

/**
 * The largest batch /eligibility/check-batch accepts. Duplicated from the
 * route rather than imported, because importing it would pull the route -
 * and with it the evaluation path, the cache, and the SQLite store - into
 * a module whose whole point is to be checkable without starting any of
 * that. Asserted equal to the route's own constant by a test.
 */
const MAX_BATCH_SIZE = 20;

/**
 * Long enough that an outage which has already ended goes unnoticed for a
 * while: the breaker only finds out a forge is back by letting one request
 * through after the cooldown.
 */
const SLOW_RECOVERY_MS = 5 * 60_000;

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

  // Deliberately warnings where the missing GitHub credential is critical.
  // A deployment can legitimately never see a GitLab or Bitbucket repo, in
  // which case these cost nothing - but if it does see one, the failure is
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

  if (!config.bitbucketToken) {
    findings.push({
      severity: "warning",
      id: "no-bitbucket-credential",
      message:
        "BITBUCKET_TOKEN is not set, so Bitbucket API calls are unauthenticated (heavily throttled) and private Bitbucket repos cannot be evaluated at all.",
      remedy:
        "Set BITBUCKET_TOKEN to an access token with repository:read, or ignore this if no Bitbucket repo will ever be checked here."
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

  // The rate limit is counted in repos, so a limit under the batch cap
  // isn't a tight limit - it is an endpoint that cannot be used at its
  // documented size at all.
  if (config.rateLimitMax < MAX_BATCH_SIZE) {
    findings.push({
      severity: "warning",
      id: "rate-limit-below-batch-size",
      message: `RATE_LIMIT_MAX is ${config.rateLimitMax}, below the ${MAX_BATCH_SIZE} repos /eligibility/check-batch accepts, so a full-size batch is refused with 429 every time however long the caller waits.`,
      remedy: `Raise RATE_LIMIT_MAX to at least ${MAX_BATCH_SIZE}, or tell callers to send batches no larger than ${config.rateLimitMax}.`
    });
  }

  // One failure is a blip; a whole forge cut off for the cooldown because
  // of one is a self-inflicted outage.
  if (config.circuitBreakerFailureThreshold < 3) {
    findings.push({
      severity: "warning",
      id: "trigger-happy-circuit-breaker",
      message: `CIRCUIT_BREAKER_FAILURE_THRESHOLD is ${config.circuitBreakerFailureThreshold}, so a brief blip stops this instance calling that forge for ${config.circuitBreakerOpenMs}ms.`,
      remedy:
        "Raise it to 3 or more. Each counted failure has already survived the retry loop, so the threshold is a count of failures that each took several attempts."
    });
  }

  if (config.circuitBreakerOpenMs > SLOW_RECOVERY_MS) {
    findings.push({
      severity: "info",
      id: "slow-circuit-recovery",
      message: `CIRCUIT_BREAKER_OPEN_MS is ${config.circuitBreakerOpenMs}ms, so a forge that recovers is still refused for up to that long - the breaker only learns it is back by letting a request through after the cooldown.`,
      remedy:
        "Shorten it unless you would rather shed load than retry, which is a reasonable choice for a forge that fails slowly."
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
