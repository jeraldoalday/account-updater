import { describe, expect, it, vi } from "vitest";
import { retrying, retryAfterSecondsToMs } from "../src/net/retry";

describe("retrying", () => {
  const always = { retries: 3, baseDelayMs: 1, isRetryable: () => true };

  it("does not call the function again when it succeeds", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    await expect(retrying(fn, always)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("stops after the configured number of retries and rethrows the last error", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("still broken"));
    await expect(retrying(fn, { ...always, retries: 2 })).rejects.toThrow("still broken");
    expect(fn).toHaveBeenCalledTimes(3); // the first attempt plus two retries
  });

  it("rethrows immediately when the policy says the error is not retryable", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("not found"));
    await expect(retrying(fn, { ...always, isRetryable: () => false })).rejects.toThrow(
      "not found"
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("asks the policy about each error, so a retryable failure can be followed by a fatal one", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("busy"), { status: 503 }))
      .mockRejectedValueOnce(Object.assign(new Error("gone"), { status: 404 }));

    await expect(
      retrying(fn, {
        ...always,
        isRetryable: (err) => (err as { status?: number }).status === 503
      })
    ).rejects.toThrow("gone");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("waits as long as the error asks rather than using the backoff schedule", async () => {
    vi.useFakeTimers();
    try {
      const fn = vi.fn().mockRejectedValueOnce(new Error("slow down")).mockResolvedValueOnce("ok");
      const pending = retrying(fn, {
        retries: 3,
        // Deliberately far apart, so which delay was used is unambiguous.
        baseDelayMs: 10_000,
        isRetryable: () => true,
        retryAfterMs: () => 250
      });

      await vi.advanceTimersByTimeAsync(250);
      await expect(pending).resolves.toBe("ok");
      expect(fn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to exponential backoff when the error names no delay", async () => {
    vi.useFakeTimers();
    try {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error("1"))
        .mockRejectedValueOnce(new Error("2"))
        .mockResolvedValueOnce("ok");
      const pending = retrying(fn, {
        retries: 3,
        baseDelayMs: 100,
        isRetryable: () => true,
        retryAfterMs: () => null
      });

      await vi.advanceTimersByTimeAsync(100); // first backoff
      expect(fn).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(200); // doubled
      await expect(pending).resolves.toBe("ok");
      expect(fn).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("retryAfterSecondsToMs", () => {
  it("converts a plain seconds count", () => {
    expect(retryAfterSecondsToMs("30")).toBe(30_000);
    expect(retryAfterSecondsToMs("0")).toBe(0);
  });

  it("returns null when the header is absent", () => {
    expect(retryAfterSecondsToMs(undefined)).toBeNull();
  });

  // A NaN delay would make the sleep resolve on the next tick, turning a
  // deliberate wait into an immediate hammering of an upstream that just
  // asked us to back off.
  it("ignores a value that is not a number, rather than producing NaN", () => {
    expect(retryAfterSecondsToMs("Wed, 21 Oct 2026 07:28:00 GMT")).toBeNull();
    expect(retryAfterSecondsToMs("")).toBeNull();
  });

  it("ignores a negative delay", () => {
    expect(retryAfterSecondsToMs("-5")).toBeNull();
  });
});
