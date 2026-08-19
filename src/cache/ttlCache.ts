import type { Cache } from "./cache";

interface Entry<V> {
  value: V;
  expiresAt: number;
}

const DEFAULT_SWEEP_EVERY_N_SETS = 1000;

/** Removes entries whose TTL has already elapsed. Exported for direct unit testing. */
export function sweepExpiredEntries<V>(store: Map<string, Entry<V>>, now: number): void {
  for (const [key, entry] of store) {
    if (now >= entry.expiresAt) store.delete(key);
  }
}

/** A minimal in-memory cache where entries expire after a fixed TTL. */
export class TtlCache<V> implements Cache<V> {
  private store = new Map<string, Entry<V>>();
  private setsSinceSweep = 0;

  constructor(
    private ttlMs: number,
    private sweepEveryNSets = DEFAULT_SWEEP_EVERY_N_SETS
  ) {}

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

    // A key whose entry expires and is never read again (e.g. a repo
    // checked once and never rechecked) would otherwise sit in `store`
    // forever, since `get()` only evicts a key it's actually asked for.
    // Sweep opportunistically so a long-running process that sees many
    // distinct keys doesn't grow unbounded.
    this.setsSinceSweep++;
    if (this.setsSinceSweep >= this.sweepEveryNSets) {
      this.setsSinceSweep = 0;
      sweepExpiredEntries(this.store, Date.now());
    }
  }

  /** Always reachable: the store is this process's own memory. */
  async ping(): Promise<void> {}

  async clear(): Promise<void> {
    this.store.clear();
  }
}
