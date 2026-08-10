interface Entry<V> {
  value: V;
  expiresAt: number;
}

/** A minimal in-memory cache where entries expire after a fixed TTL. */
export class TtlCache<K, V> {
  private store = new Map<K, Entry<V>>();

  constructor(private ttlMs: number) {}

  get(key: K): V | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() >= entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: K, value: V): void {
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  clear(): void {
    this.store.clear();
  }
}
