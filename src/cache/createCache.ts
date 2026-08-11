import { createClient, type RedisClientType } from "redis";
import { config } from "../config";
import type { Cache } from "./cache";
import { TtlCache } from "./ttlCache";
import { RedisCache } from "./redisCache";

let redisClient: RedisClientType | undefined;

function getRedisClient(): RedisClientType {
  if (!redisClient) {
    // Startup config validation already guarantees this when
    // cacheBackend === "redis"; this just keeps the failure obvious if that
    // invariant is ever broken.
    if (!config.redisUrl) {
      throw new Error("CACHE_BACKEND=redis requires REDIS_URL to be set");
    }
    redisClient = createClient({ url: config.redisUrl });
    redisClient.on("error", (err) => console.error("Redis client error:", err));
  }
  return redisClient;
}

/** Builds the eligibility-result cache backend chosen via CACHE_BACKEND. */
export function createCache<V>(): Cache<V> {
  if (config.cacheBackend === "redis") {
    return new RedisCache<V>(getRedisClient(), config.cacheTtlMs);
  }
  return new TtlCache<V>(config.cacheTtlMs);
}

/** Closes the Redis connection, if one was opened, during graceful shutdown. */
export async function closeCache(): Promise<void> {
  if (redisClient?.isOpen) {
    await redisClient.quit();
  }
}
