import { describe, expect, it } from "vitest";
import { extractRateLimitInfo } from "../src/github/rateLimitInfo";

describe("extractRateLimitInfo", () => {
  it("returns null for a non-rate-limit error", () => {
    const err = Object.assign(new Error("not found"), { status: 404 });
    expect(extractRateLimitInfo(err)).toBeNull();
  });

  it("returns null for an error with no status", () => {
    expect(extractRateLimitInfo(new Error("boom"))).toBeNull();
  });

  it("extracts remaining/reset/retry-after from a 403 with rate-limit headers", () => {
    const err = Object.assign(new Error("rate limited"), {
      status: 403,
      response: {
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": "1000000000",
          "retry-after": "30"
        }
      }
    });

    const info = extractRateLimitInfo(err);
    expect(info).toEqual({
      remaining: 0,
      resetAt: new Date(1000000000 * 1000).toISOString(),
      retryAfterSeconds: 30
    });
  });

  it("treats a 429 the same as a 403 for rate-limit detection", () => {
    const err = Object.assign(new Error("too many requests"), {
      status: 429,
      response: { headers: { "retry-after": "5" } }
    });

    const info = extractRateLimitInfo(err);
    expect(info?.retryAfterSeconds).toBe(5);
  });

  it("returns null for a 403 that is a permissions failure, not rate limiting", () => {
    // GitHub answers 403 for a token without access to a repo. Reporting
    // that as rate limiting told the caller to try again later about
    // something that will never succeed - and, in the route, turned a 502
    // into a 503.
    const err = Object.assign(new Error("Resource not accessible by integration"), {
      status: 403,
      response: { headers: { "x-ratelimit-remaining": "4783", "x-ratelimit-reset": "1000000000" } }
    });

    expect(extractRateLimitInfo(err)).toBeNull();
  });

  it("recognizes a secondary rate limit from its message alone", () => {
    const err = Object.assign(
      new Error("You have exceeded a secondary rate limit. Please wait a few minutes."),
      { status: 403, response: { headers: {} } }
    );

    expect(extractRateLimitInfo(err)).not.toBeNull();
  });

  it("recognizes primary rate limiting from an exhausted quota", () => {
    const err = Object.assign(new Error("API rate limit exceeded"), {
      status: 403,
      response: { headers: { "x-ratelimit-remaining": "0" } }
    });

    expect(extractRateLimitInfo(err)?.remaining).toBe(0);
  });

  it("returns an object with undefined fields when headers are missing", () => {
    const err = Object.assign(new Error("rate limited"), {
      status: 403,
      response: { headers: {} }
    });
    const info = extractRateLimitInfo(err);
    expect(info).toEqual({
      remaining: undefined,
      resetAt: undefined,
      retryAfterSeconds: undefined
    });
  });
});
