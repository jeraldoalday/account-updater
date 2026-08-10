import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TtlCache } from "../src/cache/ttlCache";

describe("TtlCache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns undefined for a key that was never set", () => {
    const cache = new TtlCache<string, number>(1000);
    expect(cache.get("missing")).toBeUndefined();
  });

  it("returns a value before it expires", () => {
    const cache = new TtlCache<string, number>(1000);
    cache.set("a", 42);
    vi.advanceTimersByTime(999);
    expect(cache.get("a")).toBe(42);
  });

  it("expires a value once the TTL has elapsed", () => {
    const cache = new TtlCache<string, number>(1000);
    cache.set("a", 42);
    vi.advanceTimersByTime(1000);
    expect(cache.get("a")).toBeUndefined();
  });

  it("clear() removes all entries", () => {
    const cache = new TtlCache<string, number>(1000);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.clear();
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBeUndefined();
  });
});
