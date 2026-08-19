import { beforeEach, describe, expect, it } from "vitest";
import { RedisCache, type RedisLikeClient } from "../src/cache/redisCache";

/** A minimal in-memory stand-in for the `redis` package's client, with no TTL enforcement of its own (RedisCache always passes PX, so the fake just records it). */
class FakeRedisClient implements RedisLikeClient {
  isOpen = false;
  connectCalls = 0;
  store = new Map<string, string>();
  lastSetOptions: { PX: number } | undefined;

  async connect(): Promise<void> {
    this.connectCalls++;
    this.isOpen = true;
  }

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: string, options: { PX: number }): Promise<void> {
    this.lastSetOptions = options;
    this.store.set(key, value);
  }

  async keys(pattern: string): Promise<string[]> {
    const prefix = pattern.replace(/\*$/, "");
    return [...this.store.keys()].filter((k) => k.startsWith(prefix));
  }

  async del(keys: string[]): Promise<void> {
    for (const key of keys) this.store.delete(key);
  }
}

/** A client that fails the way an unreachable Redis does. */
class UnreachableRedisClient extends FakeRedisClient {
  async connect(): Promise<void> {
    throw new Error("connect ECONNREFUSED 127.0.0.1:6379");
  }
}

describe("RedisCache", () => {
  let client: FakeRedisClient;

  beforeEach(() => {
    client = new FakeRedisClient();
  });

  it("returns undefined for a key that was never set", async () => {
    const cache = new RedisCache<{ n: number }>(client, 1000);
    expect(await cache.get("missing")).toBeUndefined();
  });

  it("round-trips a JSON-serializable value", async () => {
    const cache = new RedisCache<{ n: number }>(client, 1000);
    await cache.set("a", { n: 42 });
    expect(await cache.get("a")).toEqual({ n: 42 });
  });

  it("passes the configured TTL as a PX option on every set", async () => {
    const cache = new RedisCache<number>(client, 5000);
    await cache.set("a", 1);
    expect(client.lastSetOptions).toEqual({ PX: 5000 });
  });

  it("round-trips a PING so readiness reports on the connection itself", async () => {
    let pings = 0;
    const pingable = Object.assign(client, {
      ping: async () => {
        pings++;
        return "PONG";
      }
    });

    await new RedisCache<number>(pingable, 1000).ping();

    expect(pings).toBe(1);
    expect(client.connectCalls).toBe(1);
  });

  it("treats a client without PING as reachable once connected", async () => {
    // The fake has no ping(); a real client always does, but the readiness
    // probe must not report an outage just because a client lacks it.
    await expect(new RedisCache<number>(client, 1000).ping()).resolves.toBeUndefined();
    expect(client.isOpen).toBe(true);
  });

  it("rejects from ping() when the connection can't be established", async () => {
    const cache = new RedisCache<number>(new UnreachableRedisClient(), 1000);
    await expect(cache.ping()).rejects.toThrow("ECONNREFUSED");
  });

  it("namespaces keys so different cache instances don't collide", async () => {
    const cache = new RedisCache<number>(client, 1000, "one:");
    await cache.set("a", 1);
    expect(client.store.has("one:a")).toBe(true);
    expect(client.store.has("a")).toBe(false);
  });

  it("clear() only removes keys under this cache's prefix", async () => {
    const cache = new RedisCache<number>(client, 1000, "elig:");
    await cache.set("a", 1);
    await cache.set("b", 2);
    client.store.set("other:untouched", "1");

    await cache.clear();

    expect(await cache.get("a")).toBeUndefined();
    expect(await cache.get("b")).toBeUndefined();
    expect(client.store.has("other:untouched")).toBe(true);
  });

  it("connects a not-yet-open client lazily, once, before the first operation", async () => {
    const cache = new RedisCache<number>(client, 1000);
    await cache.set("a", 1);
    await cache.get("a");
    expect(client.connectCalls).toBe(1);
  });

  it("does not attempt to connect a client with no connection lifecycle", async () => {
    const client2: RedisLikeClient = {
      get: async () => null,
      set: async () => undefined,
      keys: async () => [],
      del: async () => undefined
    };
    const cache = new RedisCache<number>(client2, 1000);
    await expect(cache.get("a")).resolves.toBeUndefined();
  });
});
