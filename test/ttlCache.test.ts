import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TtlCache } from "../src/cache/ttlCache";

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
});
