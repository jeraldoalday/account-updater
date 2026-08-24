import "dotenv/config";
import { z } from "zod";
import type { GitHubAppAuthConfig } from "./github/octokitAuth";

// dotenv sets blank `KEY=` lines to "", which is not `undefined` and would
// otherwise bypass zod's `.default()` — treat blank the same as unset.
function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === "" ? undefined : value;
}

const configSchema = z
  .object({
    port: z.coerce.number().int().positive().default(3000),
    githubToken: z.string().optional(),
    // Alternative to githubToken: authenticate as a GitHub App installation
    // instead of a shared PAT (higher rate limits, no long-lived secret to
    // leak). Used only when no token (caller-supplied or githubToken) is
    // available for a request - see resolveOctokitAuth(). Must be set
    // together or not at all.
    githubAppId: z.string().optional(),
    githubAppPrivateKey: z.string().optional(),
    githubAppInstallationId: z.coerce.number().int().positive().optional(),
    // GitLab personal or project access token, used the same way
    // githubToken is: as the fallback credential when a request supplies
    // none of its own. Unauthenticated GitLab API calls are allowed but
    // heavily throttled, and private projects are invisible without one.
    gitlabToken: z.string().optional(),
    // Bitbucket repository, project, or workspace access token (or an
    // OAuth token), used the same way the other two are: as the fallback
    // credential when a request supplies none of its own. `repository:read`
    // is the scope the commit-history call needs.
    bitbucketToken: z.string().optional(),
    // Ceiling on a single outbound provider API call. Deliberately shared
    // rather than per-provider: it exists to stop one hung upstream from
    // holding a request open, and that concern doesn't vary by forge.
    providerRequestTimeoutMs: z.coerce.number().int().positive().default(10_000),
    // When set, callers must send a matching `x-api-key` header. Unset by
    // default so local development doesn't require one.
    apiKey: z.string().optional(),
    cacheTtlMs: z.coerce
      .number()
      .int()
      .positive()
      .default(10 * 60 * 1000),
    // "memory" (default) is per-process only. "redis" shares cached
    // eligibility results across instances of the service.
    cacheBackend: z.enum(["memory", "redis"]).default("memory"),
    redisUrl: z.string().optional(),
    // Where the SQLite audit-trail database (one row per evaluation
    // performed) lives on disk. Relative to the process's cwd unless
    // absolute.
    historyDbPath: z.string().default("./data/history.db"),
    // How long an audit-trail row is kept before a periodic sweep deletes
    // it. 0 keeps everything, for a deployment that ships the rows
    // somewhere else and wants the file to grow forever on purpose.
    historyRetentionDays: z.coerce.number().int().nonnegative().default(90),
    historyPruneIntervalMs: z.coerce
      .number()
      .int()
      .positive()
      .default(6 * 60 * 60 * 1000),
    // Applies to /eligibility, the endpoint that clones a repo and calls a
    // provider's API, so it's the one worth protecting from abuse.
    rateLimitWindowMs: z.coerce
      .number()
      .int()
      .positive()
      .default(60 * 1000),
    rateLimitMax: z.coerce.number().int().positive().default(20),
    // Shutdown pacing. `shutdownDrainMs` is how long the process keeps
    // serving after SIGTERM while /ready answers 503, so a load balancer
    // has time to notice before the listener closes; `shutdownGraceMs` is
    // the hard deadline for the whole shutdown.
    shutdownDrainMs: z.coerce.number().int().nonnegative().default(5_000),
    shutdownGraceMs: z.coerce.number().int().positive().default(20_000)
  })
  .refine((data) => data.shutdownGraceMs > data.shutdownDrainMs, {
    message:
      "SHUTDOWN_GRACE_MS must be greater than SHUTDOWN_DRAIN_MS, or the deadline fires before draining finishes",
    path: ["shutdownGraceMs"]
  })
  .refine((data) => data.cacheBackend !== "redis" || data.redisUrl !== undefined, {
    message: "REDIS_URL is required when CACHE_BACKEND=redis",
    path: ["redisUrl"]
  })
  .refine(
    (data) => {
      const set = [data.githubAppId, data.githubAppPrivateKey, data.githubAppInstallationId].filter(
        (value) => value !== undefined
      );
      return set.length === 0 || set.length === 3;
    },
    {
      message:
        "GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, and GITHUB_APP_INSTALLATION_ID must all be set together, or all left unset",
      path: ["githubAppId"]
    }
  );

function loadConfig() {
  const parsed = configSchema.safeParse({
    port: optionalEnv("PORT"),
    githubToken: optionalEnv("GITHUB_TOKEN"),
    githubAppId: optionalEnv("GITHUB_APP_ID"),
    githubAppPrivateKey: optionalEnv("GITHUB_APP_PRIVATE_KEY"),
    githubAppInstallationId: optionalEnv("GITHUB_APP_INSTALLATION_ID"),
    gitlabToken: optionalEnv("GITLAB_TOKEN"),
    bitbucketToken: optionalEnv("BITBUCKET_TOKEN"),
    providerRequestTimeoutMs: optionalEnv("PROVIDER_REQUEST_TIMEOUT_MS"),
    apiKey: optionalEnv("API_KEY"),
    cacheTtlMs: optionalEnv("CACHE_TTL_MS"),
    cacheBackend: optionalEnv("CACHE_BACKEND"),
    redisUrl: optionalEnv("REDIS_URL"),
    historyDbPath: optionalEnv("HISTORY_DB_PATH"),
    historyRetentionDays: optionalEnv("HISTORY_RETENTION_DAYS"),
    historyPruneIntervalMs: optionalEnv("HISTORY_PRUNE_INTERVAL_MS"),
    rateLimitWindowMs: optionalEnv("RATE_LIMIT_WINDOW_MS"),
    rateLimitMax: optionalEnv("RATE_LIMIT_MAX"),
    shutdownDrainMs: optionalEnv("SHUTDOWN_DRAIN_MS"),
    shutdownGraceMs: optionalEnv("SHUTDOWN_GRACE_MS")
  });

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(value)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid configuration - check your environment variables: ${issues}`);
  }

  const data = parsed.data;

  // .env files often can't hold real newlines in a PEM key, so the
  // convention is to escape them as literal "\n" and unescape here.
  const githubAppAuthConfig: GitHubAppAuthConfig | undefined =
    data.githubAppId && data.githubAppPrivateKey && data.githubAppInstallationId
      ? {
          appId: data.githubAppId,
          privateKey: data.githubAppPrivateKey.replace(/\\n/g, "\n"),
          installationId: data.githubAppInstallationId
        }
      : undefined;

  return { ...data, githubAppAuthConfig };
}

export const config = loadConfig();
