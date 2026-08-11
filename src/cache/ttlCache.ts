import type { Cache } from "./cache";

interface Entry<V> {
  value: V;
  expiresAt: number;
}

/** A minimal in-memory cache where entries expire after a fixed TTL. */
export class TtlCache<V> implements Cache<V> {
  private store = new Map<string, Entry<V>>();

  constructor(private ttlMs: number) {}

  async get(key: string): Promise<V | undefined> {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() >= entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  async set(key: string, value: V): Promise<void> {
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  async clear(): Promise<void> {
    this.store.clear();
  }
}
