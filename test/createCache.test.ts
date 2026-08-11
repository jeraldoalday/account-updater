import { afterEach, describe, expect, it, vi } from "vitest";

const ENV_KEYS = ["CACHE_BACKEND", "REDIS_URL", "CACHE_TTL_MS"] as const;
const originalEnv = { ...process.env };

/** A minimal in-memory stand-in for the `redis` package's client. */
class FakeRedisClient {
  isOpen = false;
  quitCalls = 0;
  private store = new Map<string, string>();

  on(): this {
    return this;
  }

  async connect(): Promise<void> {
    this.isOpen = true;
  }

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async keys(pattern: string): Promise<string[]> {
    const prefix = pattern.replace(/\*$/, "");
    return [...this.store.keys()].filter((k) => k.startsWith(prefix));
  }

  async del(keys: string[]): Promise<void> {
    for (const key of keys) this.store.delete(key);
  }

  async quit(): Promise<void> {
    this.quitCalls++;
    this.isOpen = false;
  }

  has(key: string): boolean {
    return this.store.has(key);
  }
}

let fakeClient: FakeRedisClient;

vi.mock("redis", () => ({
  createClient: vi.fn(() => fakeClient)
}));

async function loadCreateCacheWith(overrides: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  vi.resetModules();
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, overrides);
  fakeClient = new FakeRedisClient();
  return import("../src/cache/createCache");
}

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, originalEnv);
  vi.resetModules();
});

describe("createCache", () => {
  it("returns a working in-memory cache by default", async () => {
    const { createCache } = await loadCreateCacheWith({});
    const cache = createCache<number>();
    await cache.set("a", 1);
    expect(await cache.get("a")).toBe(1);
  });

  it("returns a Redis-backed cache when CACHE_BACKEND=redis", async () => {
    const { createCache } = await loadCreateCacheWith({
      CACHE_BACKEND: "redis",
      REDIS_URL: "redis://localhost:6379"
    });
    const cache = createCache<number>();
    await cache.set("a", 1);
    expect(await cache.get("a")).toBe(1);
    expect(fakeClient.has("account-updater:cache:a")).toBe(true);
  });

  describe("closeCache", () => {
    it("does nothing when no Redis client was ever created (memory backend)", async () => {
      const { closeCache } = await loadCreateCacheWith({});
      await expect(closeCache()).resolves.toBeUndefined();
    });

    it("does nothing when a Redis client was created but never opened", async () => {
      const { createCache, closeCache } = await loadCreateCacheWith({
        CACHE_BACKEND: "redis",
        REDIS_URL: "redis://localhost:6379"
      });
      createCache<number>();
      await closeCache();
      expect(fakeClient.quitCalls).toBe(0);
    });

    it("quits an open Redis client", async () => {
      const { createCache, closeCache } = await loadCreateCacheWith({
        CACHE_BACKEND: "redis",
        REDIS_URL: "redis://localhost:6379"
      });
      const cache = createCache<number>();
      await cache.set("a", 1); // opens the client via RedisCache's lazy connect
      await closeCache();
      expect(fakeClient.quitCalls).toBe(1);
    });
  });
});
