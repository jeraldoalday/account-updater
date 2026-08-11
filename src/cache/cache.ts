/** A pluggable cache backend, keyed by string, storing one value type. */
export interface Cache<V> {
  get(key: string): Promise<V | undefined>;
  set(key: string, value: V): Promise<void>;
  clear(): Promise<void>;
}
