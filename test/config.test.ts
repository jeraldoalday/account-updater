import { afterEach, describe, expect, it, vi } from "vitest";

const ENV_KEYS = [
  "PORT",
  "GITHUB_TOKEN",
  "API_KEY",
  "CACHE_TTL_MS",
  "CACHE_BACKEND",
  "REDIS_URL",
  "HISTORY_DB_PATH",
  "RATE_LIMIT_WINDOW_MS",
  "RATE_LIMIT_MAX"
] as const;

const originalEnv = { ...process.env };

async function loadConfigWith(overrides: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  vi.resetModules();
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, overrides);
  return import("../src/config");
}

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, originalEnv);
  vi.resetModules();
});

describe("config", () => {
  it("applies defaults when nothing is set", async () => {
    const { config } = await loadConfigWith({});
    expect(config.port).toBe(3000);
    expect(config.cacheTtlMs).toBe(10 * 60 * 1000);
    expect(config.rateLimitWindowMs).toBe(60 * 1000);
    expect(config.rateLimitMax).toBe(20);
    expect(config.githubToken).toBeUndefined();
    expect(config.apiKey).toBeUndefined();
    expect(config.cacheBackend).toBe("memory");
    expect(config.redisUrl).toBeUndefined();
    expect(config.historyDbPath).toBe("./data/history.db");
  });

  it("treats blank env values the same as unset", async () => {
    const { config } = await loadConfigWith({ PORT: "", CACHE_TTL_MS: "" });
    expect(config.port).toBe(3000);
    expect(config.cacheTtlMs).toBe(10 * 60 * 1000);
  });

  it("parses valid overrides", async () => {
    const { config } = await loadConfigWith({
      PORT: "4000",
      RATE_LIMIT_MAX: "5",
      HISTORY_DB_PATH: "/tmp/custom-history.db"
    });
    expect(config.port).toBe(4000);
    expect(config.rateLimitMax).toBe(5);
    expect(config.historyDbPath).toBe("/tmp/custom-history.db");
  });

  it("throws a clear error for a non-numeric value", async () => {
    await expect(loadConfigWith({ PORT: "not-a-number" })).rejects.toThrow(/Invalid configuration/);
  });

  it("throws for a non-positive value", async () => {
    await expect(loadConfigWith({ RATE_LIMIT_MAX: "0" })).rejects.toThrow(/Invalid configuration/);
  });

  it("accepts CACHE_BACKEND=redis when REDIS_URL is set", async () => {
    const { config } = await loadConfigWith({
      CACHE_BACKEND: "redis",
      REDIS_URL: "redis://localhost:6379"
    });
    expect(config.cacheBackend).toBe("redis");
    expect(config.redisUrl).toBe("redis://localhost:6379");
  });

  it("throws when CACHE_BACKEND=redis but REDIS_URL is unset", async () => {
    await expect(loadConfigWith({ CACHE_BACKEND: "redis" })).rejects.toThrow(/Invalid configuration/);
  });

  it("throws for an unrecognized CACHE_BACKEND value", async () => {
    await expect(loadConfigWith({ CACHE_BACKEND: "memcached" })).rejects.toThrow(/Invalid configuration/);
  });
});
