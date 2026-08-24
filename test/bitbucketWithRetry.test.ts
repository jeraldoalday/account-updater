import { describe, expect, it, vi } from "vitest";
import { withRetry } from "../src/bitbucket/withRetry";
import { HttpError, RequestTimeoutError } from "../src/net/httpJson";

const FAST = { retries: 3, baseDelayMs: 1 };

function httpError(status: number, headers: Record<string, string> = {}) {
  return new HttpError(status, "https://api.bitbucket.org/2.0/x", headers, "");
}

describe("bitbucket withRetry", () => {
  it("returns the result on first success without retrying", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    await expect(withRetry(fn, FAST)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries a 5xx and eventually succeeds", async () => {
    const fn = vi.fn().mockRejectedValueOnce(httpError(503)).mockResolvedValueOnce("ok");
    await expect(withRetry(fn, FAST)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retries a 429, which is how Bitbucket reports rate limiting", async () => {
    const fn = vi.fn().mockRejectedValueOnce(httpError(429)).mockResolvedValueOnce("ok");
    await expect(withRetry(fn, FAST)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 403, which here means insufficient scope rather than a quota", async () => {
    // The opposite of the GitHub policy, where a 403 has to be inspected
    // because it carries both meanings. On Bitbucket it only ever means
    // the token can't do this, so retrying spends the budget on a call
    // that cannot start succeeding.
    const fn = vi.fn().mockRejectedValue(httpError(403));
    await expect(withRetry(fn, FAST)).rejects.toThrow(/403/);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not retry a 401, which is what a wrong or revoked token produces", async () => {
    const fn = vi.fn().mockRejectedValue(httpError(401));
    await expect(withRetry(fn, FAST)).rejects.toThrow(/401/);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not retry a 404, so a mistyped repo fails immediately", async () => {
    const fn = vi.fn().mockRejectedValue(httpError(404));
    await expect(withRetry(fn, FAST)).rejects.toThrow(/404/);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not retry a timeout, which has already waited the full ceiling", async () => {
    const fn = vi
      .fn()
      .mockRejectedValue(new RequestTimeoutError("https://api.bitbucket.org/2.0/x", 10_000));
    await expect(withRetry(fn, FAST)).rejects.toThrow(RequestTimeoutError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("gives up after the configured number of retries", async () => {
    const fn = vi.fn().mockRejectedValue(httpError(500));
    await expect(withRetry(fn, { retries: 2, baseDelayMs: 1 })).rejects.toThrow(/500/);
    expect(fn).toHaveBeenCalledTimes(3); // the first attempt plus two retries
  });

  it("waits the Retry-After Bitbucket sent rather than its own backoff", async () => {
    vi.useFakeTimers();
    try {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(httpError(429, { "retry-after": "5" }))
        .mockResolvedValueOnce("ok");

      const pending = withRetry(fn, { retries: 3, baseDelayMs: 1000 });
      await vi.advanceTimersByTimeAsync(4999);
      expect(fn).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toBe("ok");
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to backoff when Bitbucket says nothing about when to return", async () => {
    // Bitbucket's rate limiting is a rolling hourly window and it often
    // answers 429 with no Retry-After at all, so the schedule has to hold
    // up on its own.
    vi.useFakeTimers();
    try {
      const fn = vi.fn().mockRejectedValueOnce(httpError(429)).mockResolvedValueOnce("ok");

      const pending = withRetry(fn, { retries: 3, baseDelayMs: 300 });
      await vi.advanceTimersByTimeAsync(299);
      expect(fn).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toBe("ok");
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores an unparseable Retry-After instead of retrying immediately", async () => {
    vi.useFakeTimers();
    try {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(httpError(429, { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" }))
        .mockResolvedValueOnce("ok");

      const pending = withRetry(fn, { retries: 3, baseDelayMs: 300 });
      await vi.advanceTimersByTimeAsync(299);
      expect(fn).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toBe("ok");
    } finally {
      vi.useRealTimers();
    }
  });
});
