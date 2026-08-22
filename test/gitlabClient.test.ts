import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitLabClient, projectId } from "../src/gitlab/client";
import type { RepoRef } from "../src/types";

const REF: RepoRef = { provider: "gitlab", owner: "acme", repo: "widgets" };

interface StubbedPage {
  body: unknown;
  headers?: Record<string, string>;
  status?: number;
}

/**
 * Answers by (path, page), so a test can describe the API's shape rather
 * than the exact order the client happens to fetch pages in - the client
 * fires them concurrently, and pinning the order would make the tests
 * fail on a legitimate refactor.
 */
function stubApi(routes: (url: URL) => StubbedPage | undefined) {
  const calls: URL[] = [];
  const fetchSpy = vi.fn(async (input: string, _init?: RequestInit) => {
    const url = new URL(input);
    calls.push(url);
    const page = routes(url);
    if (!page) return new Response("[]", { status: 200 });
    return new Response(JSON.stringify(page.body), {
      status: page.status ?? 200,
      headers: { "content-type": "application/json", ...page.headers }
    });
  });
  vi.stubGlobal("fetch", fetchSpy);
  return { calls, fetchSpy };
}

function commit(date: string, email: string, message: string) {
  return { id: `${date}-${email}`, authored_date: date, author_email: email, message };
}

beforeEach(() => {
  vi.stubEnv("GITLAB_TOKEN", "");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("projectId", () => {
  it("encodes the slash, which the API needs as %2F rather than a path separator", () => {
    expect(projectId(REF)).toBe("acme%2Fwidgets");
  });
});

describe("GitLabClient.getCommitHistorySummary", () => {
  it("takes the commit count from the pagination header instead of counting rows", async () => {
    const { calls } = stubApi((url) => {
      if (url.searchParams.get("per_page") === "1" && url.searchParams.get("page") === "1") {
        return {
          body: [commit("2026-06-01T10:00:00Z", "a@example.test", "latest")],
          headers: { "x-total": "1234", "x-total-pages": "1234" }
        };
      }
      if (url.searchParams.get("per_page") === "1") {
        return { body: [commit("2026-01-01T10:00:00Z", "a@example.test", "first")] };
      }
      return { body: [commit("2026-06-01T10:00:00Z", "a@example.test", "latest")] };
    });

    const summary = await new GitLabClient().getCommitHistorySummary(REF);

    expect(summary.commitCount).toBe(1234);
    expect(summary.firstCommitDate).toBe("2026-01-01T10:00:00Z");
    expect(summary.lastCommitDate).toBe("2026-06-01T10:00:00Z");
    expect(summary.historyDays).toBe(151);
    // 1234 commits, sampled 500 at most: the caller has to be able to see
    // that the distributions are based on a slice.
    expect(summary.truncated).toBe(true);
    // Bounded work: five sample pages, plus the two single-commit lookups.
    expect(calls.filter((url) => url.searchParams.get("per_page") === "100")).toHaveLength(5);
  });

  it("summarizes authors and days from the sampled commits", async () => {
    stubApi((url) => {
      if (url.searchParams.get("per_page") === "100") {
        return {
          body: [
            commit("2026-06-01T10:00:00Z", "a@example.test", "add the parser"),
            commit("2026-06-01T12:00:00Z", "b@example.test", "fix the parser"),
            commit("2026-06-02T09:00:00Z", "a@example.test", "document the parser")
          ]
        };
      }
      return {
        body: [commit("2026-06-02T09:00:00Z", "a@example.test", "document the parser")],
        headers: { "x-total": "3", "x-total-pages": "3" }
      };
    });

    const summary = await new GitLabClient().getCommitHistorySummary(REF);

    expect(summary.commitCount).toBe(3);
    expect(summary.distinctCommitDays).toBe(2);
    expect(summary.authorStats.distinctAuthors).toBe(2);
    expect(summary.truncated).toBe(false);
  });

  it("falls back to counting the sample when GitLab withholds the total", async () => {
    // GitLab drops x-total on very large result sets, so the count has to
    // degrade to something real rather than becoming NaN - which would
    // pass every threshold comparison it reached.
    stubApi((url) =>
      url.searchParams.get("page") === "1"
        ? { body: [commit("2026-06-01T10:00:00Z", "a@example.test", "work")] }
        : { body: [] }
    );

    const summary = await new GitLabClient().getCommitHistorySummary(REF);

    expect(summary.commitCount).toBe(1);
    expect(Number.isNaN(summary.commitCount)).toBe(false);
    expect(summary.firstCommitDate).toBe("2026-06-01T10:00:00Z");
  });

  it("drops an unparseable commit date rather than treating it as a real one", async () => {
    stubApi((url) => {
      if (url.searchParams.get("per_page") === "100") {
        return {
          body: [
            { authored_date: "not-a-date", author_email: "a@example.test", message: "x" },
            commit("2026-06-01T10:00:00Z", "a@example.test", "real")
          ]
        };
      }
      return {
        body: [{ authored_date: "not-a-date", author_email: "a@example.test", message: "x" }],
        headers: { "x-total": "2", "x-total-pages": "2" }
      };
    });

    const summary = await new GitLabClient().getCommitHistorySummary(REF);

    expect(summary.lastCommitDate).toBeNull();
    // One garbage date must not become its own "commit day": the distinct
    // day count is exactly what the organic-development score rewards.
    expect(summary.distinctCommitDays).toBe(1);
  });

  it("sends the token as PRIVATE-TOKEN when it has one", async () => {
    const { fetchSpy } = stubApi(() => ({ body: [] }));

    await new GitLabClient("glpat-secret").getCommitHistorySummary(REF);

    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    expect(init.headers).toMatchObject({ "private-token": "glpat-secret" });
  });

  it("sends no credential header at all when there is no token", async () => {
    const { fetchSpy } = stubApi(() => ({ body: [] }));

    await new GitLabClient().getCommitHistorySummary(REF);

    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    expect(init.headers).not.toHaveProperty("private-token");
  });

  it("URL-encodes the project path so a request reaches the project", async () => {
    const { calls } = stubApi(() => ({ body: [] }));

    await new GitLabClient().getCommitHistorySummary(REF);

    expect(calls[0].pathname).toBe("/api/v4/projects/acme%2Fwidgets/repository/commits");
  });

  it("propagates a hard API failure rather than reporting an empty history", async () => {
    // A 404 answered as "0 commits" would be reported to the caller as a
    // repo that fails the history check, which is a different - and wrong
    // - answer from "we could not read this project".
    stubApi(() => ({ body: { message: "404 Project Not Found" }, status: 404 }));

    await expect(new GitLabClient().getCommitHistorySummary(REF)).rejects.toThrow(/404/);
  });
});

describe("GitLabClient.getPushEventSummary", () => {
  function pushEvent(date: string, commitCount: number) {
    return { created_at: date, action_name: "pushed to", push_data: { commit_count: commitCount } };
  }

  it("summarizes push cadence across the recorded events", async () => {
    stubApi((url) =>
      url.pathname.endsWith("/events") && url.searchParams.get("page") === "1"
        ? {
            body: [
              pushEvent("2026-06-03T10:00:00Z", 2),
              pushEvent("2026-06-02T10:00:00Z", 1),
              pushEvent("2026-06-02T18:00:00Z", 1)
            ]
          }
        : { body: [] }
    );

    const summary = await new GitLabClient().getPushEventSummary(REF);

    expect(summary.available).toBe(true);
    expect(summary.distinctPushDays).toBe(2);
    expect(summary.maxSinglePushCommitShare).toBeCloseTo(0.5);
  });

  it("asks only for push events, not the whole activity feed", async () => {
    const { calls } = stubApi(() => ({ body: [] }));

    await new GitLabClient().getPushEventSummary(REF);

    expect(calls[0].searchParams.get("action")).toBe("pushed");
  });

  it("reports no signal, rather than failing, when the token cannot read events", async () => {
    // GitLab requires read_api for the events endpoint even on a public
    // project. A 403 there means the secondary signal is missing, which
    // the checks treat as neutral - it must not fail the whole
    // eligibility check.
    stubApi(() => ({ body: { message: "403 Forbidden" }, status: 403 }));

    const summary = await new GitLabClient().getPushEventSummary(REF);

    expect(summary).toEqual({
      available: false,
      distinctPushDays: 0,
      maxSinglePushCommitShare: 0
    });
  });

  it("reports no signal for a project with no recorded activity", async () => {
    stubApi(() => ({ body: [] }));

    const summary = await new GitLabClient().getPushEventSummary(REF);

    expect(summary.available).toBe(false);
  });

  it("stops at the page bound instead of walking the entire event history", async () => {
    // Every page comes back full, so only the cap can end the loop.
    const full = Array.from({ length: 100 }, (_, i) =>
      pushEvent(`2026-06-${String((i % 28) + 1).padStart(2, "0")}T10:00:00Z`, 1)
    );
    const { calls } = stubApi(() => ({ body: full }));

    await new GitLabClient().getPushEventSummary(REF);

    expect(calls).toHaveLength(3);
  });

  it("treats an event with no commit count as zero rather than NaN", async () => {
    stubApi((url) =>
      url.searchParams.get("page") === "1"
        ? { body: [{ created_at: "2026-06-03T10:00:00Z", push_data: null }] }
        : { body: [] }
    );

    const summary = await new GitLabClient().getPushEventSummary(REF);

    expect(summary.maxSinglePushCommitShare).toBe(0);
    expect(summary.distinctPushDays).toBe(1);
  });
});
