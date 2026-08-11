import "dotenv/config";
import { z } from "zod";

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
    // When set, callers must send a matching `x-api-key` header. Unset by
    // default so local development doesn't require one.
    apiKey: z.string().optional(),
    cacheTtlMs: z.coerce.number().int().positive().default(10 * 60 * 1000),
    // "memory" (default) is per-process only. "redis" shares cached
    // eligibility results across instances of the service.
    cacheBackend: z.enum(["memory", "redis"]).default("memory"),
    redisUrl: z.string().optional(),
    // Applies to /eligibility, the endpoint that clones a repo and calls the
    // GitHub API, so it's the one worth protecting from abuse.
    rateLimitWindowMs: z.coerce.number().int().positive().default(60 * 1000),
    rateLimitMax: z.coerce.number().int().positive().default(20)
  })
  .refine((data) => data.cacheBackend !== "redis" || data.redisUrl !== undefined, {
    message: "REDIS_URL is required when CACHE_BACKEND=redis",
    path: ["redisUrl"]
  });

function loadConfig() {
  const parsed = configSchema.safeParse({
    port: optionalEnv("PORT"),
    githubToken: optionalEnv("GITHUB_TOKEN"),
    apiKey: optionalEnv("API_KEY"),
    cacheTtlMs: optionalEnv("CACHE_TTL_MS"),
    cacheBackend: optionalEnv("CACHE_BACKEND"),
    redisUrl: optionalEnv("REDIS_URL"),
    rateLimitWindowMs: optionalEnv("RATE_LIMIT_WINDOW_MS"),
    rateLimitMax: optionalEnv("RATE_LIMIT_MAX")
  });

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(value)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid configuration - check your environment variables: ${issues}`);
  }

  return parsed.data;
}

export const config = loadConfig();
