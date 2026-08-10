import "dotenv/config";

export const config = {
  port: Number(process.env.PORT ?? 3000),
  githubToken: process.env.GITHUB_TOKEN || undefined,
  // When set, callers must send a matching `x-api-key` header. Unset by
  // default so local development doesn't require one.
  apiKey: process.env.API_KEY || undefined,
  cacheTtlMs: Number(process.env.CACHE_TTL_MS ?? 10 * 60 * 1000),
  // Applies to /eligibility, the endpoint that clones a repo and calls the
  // GitHub API, so it's the one worth protecting from abuse.
  rateLimitWindowMs: Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60 * 1000),
  rateLimitMax: Number(process.env.RATE_LIMIT_MAX ?? 20)
};
