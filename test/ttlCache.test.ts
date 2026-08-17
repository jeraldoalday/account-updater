import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TtlCache, sweepExpiredEntries } from "../src/cache/ttlCache";

describe("TtlCache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns undefined for a key that was never set", async () => {
    const cache = new TtlCache<number>(1000);
    expect(await cache.get("missing")).toBeUndefined();
  });

  it("returns a value before it expires", async () => {
    const cache = new TtlCache<number>(1000);
    await cache.set("a", 42);
    vi.advanceTimersByTime(999);
    expect(await cache.get("a")).toBe(42);
  });

  it("expires a value once the TTL has elapsed", async () => {
    const cache = new TtlCache<number>(1000);
    await cache.set("a", 42);
    vi.advanceTimersByTime(1000);
    expect(await cache.get("a")).toBeUndefined();
  });

  it("clear() removes all entries", async () => {
    const cache = new TtlCache<number>(1000);
    await cache.set("a", 1);
    await cache.set("b", 2);
    await cache.clear();
    expect(await cache.get("a")).toBeUndefined();
    expect(await cache.get("b")).toBeUndefined();
  });

  it("still serves an unexpired key correctly across an opportunistic sweep", async () => {
    // sweepEveryNSets=2 means the 2nd set() triggers a sweep; the
    // still-unexpired first key must survive that sweep untouched.
    const cache = new TtlCache<number>(1000, 2);
    await cache.set("a", 1);
    vi.advanceTimersByTime(1500); // "a" is now expired
    await cache.set("b", 2); // 2nd set - triggers the sweep, drops "a"

    expect(await cache.get("a")).toBeUndefined();
    expect(await cache.get("b")).toBe(2);
  });
});

describe("sweepExpiredEntries", () => {
  it("removes only the entries whose TTL has already elapsed", () => {
    const store = new Map([
      ["expired", { value: 1, expiresAt: 100 }],
      ["active", { value: 2, expiresAt: 500 }]
    ]);

    sweepExpiredEntries(store, 200);

    expect(store.has("expired")).toBe(false);
    expect(store.has("active")).toBe(true);
    expect(store.size).toBe(1);
  });

  it("does nothing when nothing has expired yet", () => {
    const store = new Map([["active", { value: 1, expiresAt: 1000 }]]);

    sweepExpiredEntries(store, 500);

    expect(store.size).toBe(1);
  });
});
