import "dotenv/config";

export const config = {
  port: Number(process.env.PORT ?? 3000),
  githubToken: process.env.GITHUB_TOKEN || undefined,
  // When set, callers must send a matching `x-api-key` header. Unset by
  // default so local development doesn't require one.
  apiKey: process.env.API_KEY || undefined,
  cacheTtlMs: Number(process.env.CACHE_TTL_MS ?? 10 * 60 * 1000)
};
