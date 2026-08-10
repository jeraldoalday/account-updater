import { describe, expect, it, vi } from "vitest";
import { withRetry } from "../src/github/withRetry";

function errorWithStatus(status: number, headers?: Record<string, string>) {
  return Object.assign(new Error(`status ${status}`), { status, response: { headers } });
}

describe("withRetry", () => {
  it("returns the result on first success without retrying", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn, { retries: 3, baseDelayMs: 1 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on a 5xx error and eventually succeeds", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(errorWithStatus(503))
      .mockResolvedValueOnce("ok");
    const result = await withRetry(fn, { retries: 3, baseDelayMs: 1 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retries on 403 (rate limiting) and 429", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(errorWithStatus(403))
      .mockRejectedValueOnce(errorWithStatus(429))
      .mockResolvedValueOnce("ok");
    const result = await withRetry(fn, { retries: 3, baseDelayMs: 1 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("gives up and throws after exhausting retries", async () => {
    const fn = vi.fn().mockRejectedValue(errorWithStatus(500));
    await expect(withRetry(fn, { retries: 2, baseDelayMs: 1 })).rejects.toThrow("status 500");
    expect(fn).toHaveBeenCalledTimes(3); // initial attempt + 2 retries
  });

  it("does not retry a non-retryable error like 404", async () => {
    const fn = vi.fn().mockRejectedValue(errorWithStatus(404));
    await expect(withRetry(fn, { retries: 3, baseDelayMs: 1 })).rejects.toThrow("status 404");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("honors a Retry-After header instead of exponential backoff", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(errorWithStatus(429, { "retry-after": "0" }))
      .mockResolvedValueOnce("ok");
    const start = Date.now();
    const result = await withRetry(fn, { retries: 1, baseDelayMs: 5000 });
    expect(result).toBe("ok");
    expect(Date.now() - start).toBeLessThan(1000);
  });
});
