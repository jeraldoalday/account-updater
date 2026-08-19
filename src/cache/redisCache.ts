import type { Cache } from "./cache";

/**
 * The subset of the `redis` package's client surface RedisCache depends on,
 * so tests can inject a fake in-memory implementation instead of requiring
 * a real Redis server. `connect`/`isOpen` are optional since a fake test
 * client has no connection lifecycle to manage.
 */
export interface RedisLikeClient {
  isOpen?: boolean;
  connect?(): Promise<unknown>;
  get(key: string): Promise<string | null>;
  ping?(): Promise<unknown>;
  set(key: string, value: string, options: { PX: number }): Promise<unknown>;
  keys(pattern: string): Promise<string[]>;
  del(keys: string[]): Promise<unknown>;
}

/**
 * A cache backend on top of Redis, so multiple instances of the service can
 * share results instead of each starting cold. Values are JSON-serialized;
 * keys are namespaced under `keyPrefix` so `clear()` (used by tests/admin
 * tooling, not the request path) only ever touches this cache's own keys in
 * a Redis instance that may be shared with other data.
 */
export class RedisCache<V> implements Cache<V> {
  constructor(
    private client: RedisLikeClient,
    private ttlMs: number,
    private keyPrefix = "account-updater:cache:"
  ) {}

  private namespacedKey(key: string): string {
    return `${this.keyPrefix}${key}`;
  }

  private async ensureConnected(): Promise<void> {
    if (this.client.connect && this.client.isOpen === false) {
      await this.client.connect();
    }
  }

  async get(key: string): Promise<V | undefined> {
    await this.ensureConnected();
    const raw = await this.client.get(this.namespacedKey(key));
    if (raw === null) return undefined;
    return JSON.parse(raw) as V;
  }

  async set(key: string, value: V): Promise<void> {
    await this.ensureConnected();
    await this.client.set(this.namespacedKey(key), JSON.stringify(value), { PX: this.ttlMs });
  }

  /**
   * Round-trips a PING so the readiness probe reports on the connection
   * itself rather than on whether a key happens to be cached. A client
   * without PING (a test fake) is treated as reachable once connected.
   */
  async ping(): Promise<void> {
    await this.ensureConnected();
    if (this.client.ping) await this.client.ping();
  }

  async clear(): Promise<void> {
    await this.ensureConnected();
    const keys = await this.client.keys(`${this.keyPrefix}*`);
    if (keys.length > 0) {
      await this.client.del(keys);
    }
  }
}
