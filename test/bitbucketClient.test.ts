import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BitbucketClient, authorKeyOf, isSameEndpoint, repoPath } from "../src/bitbucket/client";
import type { RepoRef } from "../src/types";

const REF: RepoRef = { provider: "bitbucket", owner: "acme", repo: "widgets" };
const COMMITS_URL = "https://api.bitbucket.org/2.0/repositories/acme/widgets/commits";

interface StubbedPage {
  body: unknown;
  status?: number;
  headers?: Record<string, string>;
}

/**
 * Answers by URL, so a test describes the API's shape rather than the
 * client's call order. Unlike the GitLab stub this one has to model a
 * cursor: Bitbucket paginates commits with a `next` link and no page
 * numbers, which is the whole reason the client walks pages in sequence.
 */
function stubApi(routes: (url: URL) => StubbedPage | undefined) {
  const calls: URL[] = [];
  const inits: (RequestInit | undefined)[] = [];
  const fetchSpy = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    calls.push(url);
    inits.push(init);
    const page = routes(url);
    if (!page) return new Response(JSON.stringify({ values: [] }), { status: 200 });
    return new Response(JSON.stringify(page.body), {
      status: page.status ?? 200,
      headers: { "content-type": "application/json", ...page.headers }
    });
  });
  vi.stubGlobal("fetch", fetchSpy);
  return { calls, inits, fetchSpy };
}

function commit(date: string, email: string, message: string, nickname?: string) {
  return {
    hash: `${date}-${email}`,
    date,
    message,
    author: {
      raw: `Some One <${email}>`,
      ...(nickname ? { user: { nickname } } : {})
    }
  };
}

/** A cursor page: `values` plus the link to the page after it. */
function page(values: unknown[], next?: string) {
  return { values, ...(next ? { next } : {}) };
}

beforeEach(() => {
  vi.stubEnv("BITBUCKET_TOKEN", "");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("repoPath", () => {
  it("addresses a repo as workspace/slug", () => {
    expect(repoPath(REF)).toBe("acme/widgets");
  });

  it("encodes each segment, so a stray slash cannot add a path segment", () => {
    expect(repoPath({ provider: "bitbucket", owner: "a/b", repo: "c d" })).toBe("a%2Fb/c%20d");
  });
});

describe("authorKeyOf", () => {
  it("prefers the Bitbucket account nickname, which survives a second machine", () => {
    expect(
      authorKeyOf({ author: { raw: "S <s@example.test>", user: { nickname: "someone" } } })
    ).toBe("someone");
  });

  it("falls back to the commit email when the author has no linked account", () => {
    expect(authorKeyOf({ author: { raw: "Some One <s@example.test>" } })).toBe("s@example.test");
  });

  it("falls back to the raw author line when there is no email in it", () => {
    expect(authorKeyOf({ author: { raw: "Some One" } })).toBe("Some One");
  });

  it("returns null when there is no author at all, rather than an empty key", () => {
    // An empty-string key would be counted as a real, distinct author by
    // the contributor-diversity signal.
    expect(authorKeyOf({})).toBeNull();
    expect(authorKeyOf({ author: { raw: "   " } })).toBeNull();
  });
});

describe("isSameEndpoint", () => {
  it("accepts a next link that differs only in its cursor", () => {
    expect(isSameEndpoint(`${COMMITS_URL}?ctx=abc123`, `${COMMITS_URL}?pagelen=100`)).toBe(true);
  });

  it("rejects a next link pointing at another host", () => {
    // The one piece of request input this service does not build itself,
    // so an upstream must not be able to redirect the walk - the caller's
    // token would go with it.
    expect(
      isSameEndpoint("https://evil.test/2.0/repositories/acme/widgets/commits", COMMITS_URL)
    ).toBe(false);
  });

  it("rejects a next link pointing at another path on the same host", () => {
    expect(
      isSameEndpoint("https://api.bitbucket.org/2.0/user/permissions/repositories", COMMITS_URL)
    ).toBe(false);
  });

  it("rejects a non-https or unparseable next link", () => {
    expect(
      isSameEndpoint("http://api.bitbucket.org/2.0/repositories/acme/widgets/commits", COMMITS_URL)
    ).toBe(false);
    expect(isSameEndpoint("not a url", COMMITS_URL)).toBe(false);
  });

  it("treats a missing next link as the end of the walk", () => {
    expect(isSameEndpoint(undefined, COMMITS_URL)).toBe(false);
    expect(isSameEndpoint(null, COMMITS_URL)).toBe(false);
  });
});

describe("BitbucketClient.getCommitHistorySummary", () => {
  it("counts the commits it walked, since Bitbucket reports no total", async () => {
    const { calls } = stubApi(() => ({
      body: page([
        commit("2026-06-01T10:00:00+00:00", "a@example.test", "add the parser"),
        commit("2026-06-02T12:00:00+00:00", "b@example.test", "fix the parser")
      ])
    }));

    const summary = await new BitbucketClient().getCommitHistorySummary(REF);

    expect(summary.commitCount).toBe(2);
    expect(summary.firstCommitDate).toBe("2026-06-01T10:00:00+00:00");
    expect(summary.lastCommitDate).toBe("2026-06-02T12:00:00+00:00");
    expect(summary.historyDays).toBe(1);
    expect(summary.truncated).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0].host).toBe("api.bitbucket.org");
  });

  it("asks only for the fields it reads, since the full commit object is enormous", async () => {
    const { calls } = stubApi(() => ({ body: page([]) }));

    await new BitbucketClient().getCommitHistorySummary(REF);

    const fields = calls[0].searchParams.get("fields")?.split(",") ?? [];
    expect(fields).toContain("values.date");
    expect(fields).toContain("values.author.raw");
    // Without this the pagination link is filtered out too, and the walk
    // stops after one page while reporting a confident, wrong count.
    expect(fields).toContain("next");
    expect(calls[0].searchParams.get("pagelen")).toBe("100");
  });

  it("follows the cursor across pages", async () => {
    const secondPage = `${COMMITS_URL}?ctx=page-2`;
    const { calls } = stubApi((url) => {
      if (url.searchParams.get("ctx") === "page-2") {
        return { body: page([commit("2026-05-01T09:00:00+00:00", "a@example.test", "first")]) };
      }
      return {
        body: page([commit("2026-06-01T10:00:00+00:00", "a@example.test", "latest")], secondPage)
      };
    });

    const summary = await new BitbucketClient().getCommitHistorySummary(REF);

    expect(calls).toHaveLength(2);
    expect(summary.commitCount).toBe(2);
    expect(summary.firstCommitDate).toBe("2026-05-01T09:00:00+00:00");
    expect(summary.lastCommitDate).toBe("2026-06-01T10:00:00+00:00");
  });

  it("stops rather than following a next link to another host", async () => {
    const { calls } = stubApi((url) => {
      if (url.host !== "api.bitbucket.org") {
        return { body: page([commit("2026-01-01T00:00:00+00:00", "x@example.test", "leaked")]) };
      }
      return {
        body: page(
          [commit("2026-06-01T10:00:00+00:00", "a@example.test", "work")],
          "https://evil.test/2.0/repositories/acme/widgets/commits?ctx=2"
        )
      };
    });

    const summary = await new BitbucketClient().getCommitHistorySummary(REF);

    expect(calls).toHaveLength(1);
    expect(calls.every((url) => url.host === "api.bitbucket.org")).toBe(true);
    expect(summary.commitCount).toBe(1);
  });

  it("caps the walk and reports the result as truncated", async () => {
    // 100 commits per page with a next link that never ends: the walk has
    // to stop on its own, or one large repo becomes an unbounded number of
    // API calls.
    const { calls } = stubApi((url) => {
      const cursor = Number(url.searchParams.get("ctx") ?? "0");
      const values = Array.from({ length: 100 }, (_, i) =>
        commit(
          `2026-06-${String((i % 28) + 1).padStart(2, "0")}T10:00:00+00:00`,
          "a@example.test",
          `work ${cursor}-${i}`
        )
      );
      return { body: page(values, `${COMMITS_URL}?ctx=${cursor + 1}`) };
    });

    const summary = await new BitbucketClient().getCommitHistorySummary(REF);

    expect(summary.commitCount).toBe(500);
    expect(summary.truncated).toBe(true);
    expect(calls).toHaveLength(5);
  });

  it("summarizes authors, days, and messages from the walked commits", async () => {
    stubApi(() => ({
      body: page([
        commit("2026-06-01T10:00:00+00:00", "a@example.test", "add the parser"),
        commit("2026-06-01T12:00:00+00:00", "b@example.test", "fix the parser", "bee"),
        commit("2026-06-02T09:00:00+00:00", "a@example.test", "document the parser")
      ])
    }));

    const summary = await new BitbucketClient().getCommitHistorySummary(REF);

    expect(summary.distinctCommitDays).toBe(2);
    expect(summary.authorStats.distinctAuthors).toBe(2);
    expect(summary.messageStats.sampled).toBe(3);
    expect(summary.commitsByDay["2026-06-01"]).toBe(2);
  });

  it("finds the ends of the range by instant, not by row order", async () => {
    // Bitbucket lists commits by topological walk, so a merged branch can
    // put an older commit above a newer one - and two ISO timestamps in
    // different UTC offsets sort lexicographically in the wrong order.
    stubApi(() => ({
      body: page([
        commit("2026-06-01T02:00:00+00:00", "a@example.test", "merge"),
        commit("2026-06-01T05:00:00+09:00", "b@example.test", "earlier, but written in Tokyo"),
        commit("2026-06-03T01:00:00+00:00", "a@example.test", "newest")
      ])
    }));

    const summary = await new BitbucketClient().getCommitHistorySummary(REF);

    // 05:00+09:00 is 20:00 the previous day in UTC, the oldest of the three.
    expect(summary.lastCommitDate).toBe("2026-06-03T01:00:00+00:00");
    expect(summary.firstCommitDate).toBe("2026-06-01T05:00:00+09:00");
  });

  it("drops an unparseable commit date instead of letting it become a real day", async () => {
    stubApi(() => ({
      body: page([
        { hash: "1", date: "not a date", message: "junk", author: { raw: "A <a@example.test>" } },
        commit("2026-06-02T09:00:00+00:00", "a@example.test", "real")
      ])
    }));

    const summary = await new BitbucketClient().getCommitHistorySummary(REF);

    expect(summary.firstCommitDate).toBe("2026-06-02T09:00:00+00:00");
    expect(summary.lastCommitDate).toBe("2026-06-02T09:00:00+00:00");
    expect(summary.distinctCommitDays).toBe(1);
    expect(Number.isNaN(summary.historyDays)).toBe(false);
  });

  it("returns an empty summary for a repo with no commits", async () => {
    stubApi(() => ({ body: page([]) }));

    const summary = await new BitbucketClient().getCommitHistorySummary(REF);

    expect(summary.commitCount).toBe(0);
    expect(summary.firstCommitDate).toBeNull();
    expect(summary.historyDays).toBe(0);
    expect(summary.truncated).toBe(false);
  });

  it("sends the token as a bearer credential, and nothing when there is none", async () => {
    const { inits } = stubApi(() => ({ body: page([]) }));

    await new BitbucketClient("token-abc").getCommitHistorySummary(REF);
    expect((inits[0]?.headers as Record<string, string>).authorization).toBe("Bearer token-abc");

    await new BitbucketClient().getCommitHistorySummary(REF);
    expect((inits[1]?.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it("surfaces an API failure rather than reporting an empty history", async () => {
    // A 404 that degraded to "0 commits" would be reported to the caller
    // as a repo that fails the history check, which is a different and
    // much more confusing answer than "we could not read this repo".
    stubApi(() => ({ body: { type: "error" }, status: 404 }));

    await expect(new BitbucketClient().getCommitHistorySummary(REF)).rejects.toThrow(/404/);
  });
});

describe("BitbucketClient.getPushEventSummary", () => {
  it("reports no signal, because Bitbucket Cloud has no repository events API", async () => {
    const { calls } = stubApi(() => ({ body: page([]) }));

    const pushes = await new BitbucketClient().getPushEventSummary(REF);

    expect(pushes).toEqual({
      available: false,
      distinctPushDays: 0,
      maxSinglePushCommitShare: 0
    });
    // "No signal" is a fact about the API, not something to go and ask
    // about on every check.
    expect(calls).toHaveLength(0);
  });
});
