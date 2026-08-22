import { describe, expect, it } from "vitest";
import { extractRateLimitInfo, isRateLimitError } from "../src/net/rateLimitInfo";

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

/**
 * GitLab follows the IETF RateLimit-Headers draft and sends the same three
 * values without the `x-` prefix GitHub uses. A caller turned away by
 * either forge should learn the same thing about when to come back, rather
 * than the answer depending on which one they asked about.
 */
describe("extractRateLimitInfo with GitLab-style headers", () => {
  function gitlabError(headers: Record<string, string>, status = 429) {
    return Object.assign(new Error(`${status} from gitlab`), { status, response: { headers } });
  }

  it("reads the unprefixed remaining and reset headers", () => {
    const info = extractRateLimitInfo(
      gitlabError({ "ratelimit-remaining": "0", "ratelimit-reset": "1780000000" })
    );

    expect(info?.remaining).toBe(0);
    expect(info?.resetAt).toBe(new Date(1_780_000_000 * 1000).toISOString());
  });

  it("prefers the prefixed spelling when a proxy has added both", () => {
    const info = extractRateLimitInfo(
      gitlabError({ "x-ratelimit-remaining": "7", "ratelimit-remaining": "0" })
    );

    expect(info?.remaining).toBe(7);
  });

  it("reports Retry-After from a 429, which is the status GitLab uses", () => {
    const info = extractRateLimitInfo(gitlabError({ "retry-after": "60" }));

    expect(info?.retryAfterSeconds).toBe(60);
  });

  it("treats an unparseable reset as unknown rather than an Invalid Date", () => {
    // The value ends up in a JSON response; "Invalid Date" there looks
    // like information and isn't.
    const info = extractRateLimitInfo(gitlabError({ "ratelimit-reset": "soon" }));

    expect(info?.resetAt).toBeUndefined();
  });

  it("treats an unparseable retry-after as unknown, since it becomes a response header", () => {
    const info = extractRateLimitInfo(gitlabError({ "retry-after": "later" }));

    expect(info?.retryAfterSeconds).toBeUndefined();
  });

  it("counts a 403 with an exhausted unprefixed quota as rate limiting", () => {
    expect(isRateLimitError(gitlabError({ "ratelimit-remaining": "0" }, 403))).toBe(true);
  });

  it("still treats a 403 with quota left as a permissions failure", () => {
    expect(isRateLimitError(gitlabError({ "ratelimit-remaining": "58" }, 403))).toBe(false);
  });
});
