import { describe, expect, it } from "vitest";
import { isUpstreamUnavailable as bitbucketUnavailable } from "../src/bitbucket/withRetry";
import { isUpstreamUnavailable as githubUnavailable } from "../src/github/withRetry";
import { isUpstreamUnavailable as gitlabUnavailable } from "../src/gitlab/withRetry";
import { isNetworkError } from "../src/net/networkErrors";
import { HttpError, RequestTimeoutError } from "../src/net/httpJson";

function httpError(status: number, headers: Record<string, string> = {}): HttpError {
  return new HttpError(status, "https://api.example.test/repos/acme/widgets", headers, "");
}

function errno(code: string): Error {
  return Object.assign(new Error(`connect ${code}`), { code });
}

describe("isNetworkError", () => {
  it("recognizes the errnos that mean the request never got an answer", () => {
    for (const code of ["ECONNREFUSED", "ENOTFOUND", "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN"]) {
      expect(isNetworkError(errno(code))).toBe(true);
    }
  });

  // fetch reports these as a bare "TypeError: fetch failed" with the real
  // errno buried in cause, so only walking the chain finds it.
  it("finds an errno hidden behind a cause chain", () => {
    const wrapped = new TypeError("fetch failed", { cause: errno("ECONNREFUSED") });
    expect(isNetworkError(wrapped)).toBe(true);
  });

  // The permissive reading of "no HTTP status means the forge is down"
  // would make an ordinary bug in this service look exactly like an
  // outage, and open a breaker on it.
  it("does not treat an ordinary programming error as a network failure", () => {
    expect(isNetworkError(new TypeError("x.map is not a function"))).toBe(false);
    expect(isNetworkError(new Error("something went wrong"))).toBe(false);
  });

  it("handles a self-referencing cause chain without spinning", () => {
    const circular = new Error("loop") as Error & { cause?: unknown };
    circular.cause = circular;
    expect(isNetworkError(circular)).toBe(false);
  });

  // The chain walk is bounded so a pathological (but non-circular) cause
  // chain can't be used to make this check expensive. That bound is only
  // meaningful if it actually stops the walk before the end of a long
  // chain, which these two cases pin down on either side of it.
  it("finds an errno within the bounded cause-chain depth", () => {
    let chain: Error = errno("ECONNREFUSED");
    for (let i = 0; i < 3; i++) {
      chain = new Error(`wrap ${i}`, { cause: chain });
    }
    expect(isNetworkError(chain)).toBe(true);
  });

  it("stops walking the cause chain past the depth bound", () => {
    let chain: Error = errno("ECONNREFUSED");
    for (let i = 0; i < 6; i++) {
      chain = new Error(`wrap ${i}`, { cause: chain });
    }
    expect(isNetworkError(chain)).toBe(false);
  });

  it("is unbothered by a null or undefined error", () => {
    expect(isNetworkError(null)).toBe(false);
    expect(isNetworkError(undefined)).toBe(false);
  });
});

describe("isUpstreamUnavailable, per forge", () => {
  const forges = [
    { name: "GitHub", fn: githubUnavailable },
    { name: "GitLab", fn: gitlabUnavailable },
    { name: "Bitbucket", fn: bitbucketUnavailable }
  ];

  for (const { name, fn } of forges) {
    describe(name, () => {
      it("counts a server error", () => {
        expect(fn(httpError(500))).toBe(true);
        expect(fn(httpError(503))).toBe(true);
      });

      it("counts an unreachable host", () => {
        expect(fn(errno("ECONNREFUSED"))).toBe(true);
      });

      // A repo that doesn't exist is an answer, and an upstream that
      // answers is up. Counting these would let one caller's run of bad
      // references cut everyone else off from a healthy forge.
      it("does not count a repo that isn't there", () => {
        expect(fn(httpError(404))).toBe(false);
      });

      // A credential problem fails identically forever. Reporting it as an
      // outage sends an operator to the forge's status page instead of to
      // their own environment.
      it("does not count a credential that isn't accepted", () => {
        expect(fn(httpError(401))).toBe(false);
        expect(fn(httpError(403))).toBe(false);
      });

      // The quota is ours, not the forge's health, and the service already
      // answers a rate-limited check with the reset time the forge gave.
      it("does not count rate limiting", () => {
        expect(fn(httpError(429))).toBe(false);
      });

      it("does not count an error that says nothing about the network", () => {
        expect(fn(new TypeError("x.map is not a function"))).toBe(false);
      });
    });
  }

  // GitHub's 403 means both "rate limited" and "you can't see this repo",
  // which is why it is the one status that has to be inspected rather than
  // classified.
  it("does not count a GitHub 403 carrying rate-limit evidence", () => {
    const err = Object.assign(new Error("API rate limit exceeded"), {
      status: 403,
      response: { headers: { "x-ratelimit-remaining": "0" } }
    });
    expect(githubUnavailable(err)).toBe(false);
  });

  it("does not count a GitHub 403 that is a plain permissions failure either", () => {
    const err = Object.assign(new Error("Must have admin rights"), {
      status: 403,
      response: { headers: {} }
    });
    expect(githubUnavailable(err)).toBe(false);
  });

  // A timeout is not retried - it has already waited the full ceiling -
  // but it is the clearest evidence there is that the forge is not
  // answering, so the two predicates deliberately disagree about it.
  it("counts a timed-out request on the forges that report one", () => {
    const timedOut = new RequestTimeoutError("https://api.example.test/x", 10_000);
    expect(gitlabUnavailable(timedOut)).toBe(true);
    expect(bitbucketUnavailable(timedOut)).toBe(true);
  });
});
