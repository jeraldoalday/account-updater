/** A pluggable cache backend, keyed by string, storing one value type. */
export interface Cache<V> {
  get(key: string): Promise<V | undefined>;
  set(key: string, value: V): Promise<void>;
  clear(): Promise<void>;
  /**
   * Resolves if the backend is reachable, rejects if it is not. Used by the
   * readiness probe: a request-path failure degrades to a cache miss (see
   * evaluate.ts), so without an explicit check an unreachable shared cache
   * is invisible until someone reads the cacheErrors counter.
   */
  ping(): Promise<void>;
}
