import { beforeEach, describe, expect, it, vi } from "vitest";

const listCommits = vi.fn();
const listRepoEvents = vi.fn();

// A class, not vi.fn().mockImplementation(() => ...): the client calls
// `new Octokit(...)`, and an arrow-function implementation isn't
// constructible.
vi.mock("@octokit/rest", () => ({
  Octokit: class {
    rest = {
      repos: { listCommits },
      activity: { listRepoEvents }
    };
  }
}));

const { GitHubClient } = await import("../src/github/client");

function commitsPage(dates: string[], headers: Record<string, string> = {}) {
  return {
    headers,
    data: dates.map((date, i) => ({
      author: { login: `author-${i % 2}` },
      commit: { author: { date }, message: `commit message ${i}` }
    }))
  };
}

function linkHeader(lastPage: number) {
  return `<https://api.github.com/repos/o/r/commits?page=${lastPage}>; rel="last"`;
}

describe("GitHubClient.getCommitHistorySummary", () => {
  const ref = { provider: "github" as const, owner: "octocat", repo: "hello-world" };

  beforeEach(() => {
    listCommits.mockReset();
  });

  it("derives the exact commit count and date range from the Link header", async () => {
    // page 1 (per_page=1): newest commit, Link header says 3 total commits
    listCommits.mockImplementation(({ per_page, page }: { per_page: number; page: number }) => {
      if (per_page === 1 && page === 1) {
        return commitsPage(["2026-01-20T00:00:00Z"], { link: linkHeader(3) });
      }
      if (per_page === 1 && page === 3) {
        return commitsPage(["2026-01-01T00:00:00Z"]);
      }
      if (per_page === 100 && page === 1) {
        return commitsPage([
          "2026-01-20T00:00:00Z",
          "2026-01-10T00:00:00Z",
          "2026-01-01T00:00:00Z"
        ]);
      }
      throw new Error(`unexpected listCommits call: ${JSON.stringify({ per_page, page })}`);
    });

    const client = new GitHubClient(undefined);
    const summary = await client.getCommitHistorySummary(ref);

    expect(summary.commitCount).toBe(3);
    expect(summary.firstCommitDate).toBe("2026-01-01T00:00:00Z");
    expect(summary.lastCommitDate).toBe("2026-01-20T00:00:00Z");
    expect(summary.historyDays).toBe(19);
    expect(summary.truncated).toBe(false);
  });

  it("paginates the commit sample across multiple 100-commit pages", async () => {
    const page1Dates = Array.from(
      { length: 100 },
      (_, i) => `2026-01-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`
    );
    const page2Dates = ["2025-12-15T00:00:00Z", "2025-12-01T00:00:00Z"];

    listCommits.mockImplementation(({ per_page, page }: { per_page: number; page: number }) => {
      if (per_page === 1 && page === 1) {
        return commitsPage([page1Dates[0]], { link: linkHeader(102) });
      }
      if (per_page === 1 && page === 102) {
        return commitsPage([page2Dates[1]]);
      }
      if (per_page === 100 && page === 1) {
        return commitsPage(page1Dates);
      }
      if (per_page === 100 && page === 2) {
        return commitsPage(page2Dates);
      }
      throw new Error(`unexpected listCommits call: ${JSON.stringify({ per_page, page })}`);
    });

    const client = new GitHubClient(undefined);
    const summary = await client.getCommitHistorySummary(ref);

    expect(summary.commitCount).toBe(102);
    expect(summary.authorStats.sampled).toBe(102);
    expect(summary.truncated).toBe(false);
  });

  it("marks the sample truncated when the commit count exceeds the sample cap", async () => {
    listCommits.mockImplementation(({ per_page, page }: { per_page: number; page: number }) => {
      if (per_page === 1 && page === 1) {
        return commitsPage(["2026-01-20T00:00:00Z"], { link: linkHeader(1000) });
      }
      if (per_page === 1 && page === 1000) {
        return commitsPage(["2020-01-01T00:00:00Z"]);
      }
      if (per_page === 100) {
        return commitsPage(Array(100).fill("2026-01-01T00:00:00Z"));
      }
      throw new Error(`unexpected listCommits call: ${JSON.stringify({ per_page, page })}`);
    });

    const client = new GitHubClient(undefined);
    const summary = await client.getCommitHistorySummary(ref);

    expect(summary.commitCount).toBe(1000);
    expect(summary.truncated).toBe(true); // sample capped at 500 < 1000 total
    expect(summary.authorStats.sampled).toBe(500);
  });

  it("falls back to the single fetched commit when there is no Link header (repo has one commit)", async () => {
    listCommits.mockImplementation(({ per_page, page }: { per_page: number; page: number }) => {
      if (per_page === 1 && page === 1) {
        return commitsPage(["2026-01-15T00:00:00Z"]); // no link header
      }
      if (per_page === 100 && page === 1) {
        return commitsPage(["2026-01-15T00:00:00Z"]);
      }
      throw new Error(`unexpected listCommits call: ${JSON.stringify({ per_page, page })}`);
    });

    const client = new GitHubClient(undefined);
    const summary = await client.getCommitHistorySummary(ref);

    expect(summary.commitCount).toBe(1);
    expect(summary.firstCommitDate).toBe("2026-01-15T00:00:00Z");
    expect(summary.lastCommitDate).toBe("2026-01-15T00:00:00Z");
    expect(summary.historyDays).toBe(0);
  });
});

describe("GitHubClient.getPushEventSummary", () => {
  const ref = { provider: "github" as const, owner: "octocat", repo: "hello-world" };

  beforeEach(() => {
    listRepoEvents.mockReset();
  });

  it("summarizes push events into distinct days and the largest single-push share", async () => {
    listRepoEvents.mockImplementation(({ page }: { page: number }) => {
      if (page === 1) {
        return {
          data: [
            {
              type: "PushEvent",
              created_at: "2026-01-10T00:00:00Z",
              payload: { distinct_size: 5 }
            },
            {
              type: "PushEvent",
              created_at: "2026-01-11T00:00:00Z",
              payload: { distinct_size: 1 }
            },
            { type: "WatchEvent", created_at: "2026-01-12T00:00:00Z", payload: {} }
          ]
        };
      }
      return { data: [] };
    });

    const client = new GitHubClient(undefined);
    const summary = await client.getPushEventSummary(ref);

    expect(summary.available).toBe(true);
    expect(summary.distinctPushDays).toBe(2);
    expect(summary.maxSinglePushCommitShare).toBeCloseTo(5 / 6);
  });

  it("reports unavailable when the events API returns nothing", async () => {
    listRepoEvents.mockResolvedValue({ data: [] });

    const client = new GitHubClient(undefined);
    const summary = await client.getPushEventSummary(ref);

    expect(summary.available).toBe(false);
    expect(summary.distinctPushDays).toBe(0);
    expect(summary.maxSinglePushCommitShare).toBe(0);
  });

  it("treats the events API being unavailable (e.g. 404) as no signal rather than failing", async () => {
    listRepoEvents.mockRejectedValue(Object.assign(new Error("Not Found"), { status: 404 }));

    const client = new GitHubClient(undefined);
    const summary = await client.getPushEventSummary(ref);

    expect(summary.available).toBe(false);
  });
});

describe("GitHubClient with malformed commit data", () => {
  const ref = { provider: "github" as const, owner: "octocat", repo: "hello-world" };

  beforeEach(() => {
    listCommits.mockReset();
  });

  it("reports a zero span, not NaN, when commit dates are unparseable", async () => {
    // A commit's author date is client-supplied metadata, so it can be
    // anything. Before this was guarded, an unparseable date produced
    // historyDays: NaN, which satisfied the minimum-span check because
    // every comparison against NaN is false.
    listCommits.mockImplementation(({ per_page, page }: { per_page: number; page: number }) => {
      if (per_page === 1 && page === 1) {
        return commitsPage(["not-a-date"], { link: linkHeader(2) });
      }
      if (per_page === 1 && page === 2) {
        return commitsPage(["also-garbage"]);
      }
      return commitsPage(["not-a-date", "also-garbage"]);
    });

    const summary = await new GitHubClient(undefined).getCommitHistorySummary(ref);

    expect(summary.historyDays).toBe(0);
    expect(Number.isNaN(summary.historyDays)).toBe(false);
    // Unparseable timestamps are reported as absent rather than echoed
    // back as if they were real dates.
    expect(summary.firstCommitDate).toBeNull();
    expect(summary.lastCommitDate).toBeNull();
    expect(summary.distinctCommitDays).toBe(0);
  });

  it("tolerates commits with no author object at all", async () => {
    listCommits.mockImplementation(() => ({
      headers: {},
      data: [{ author: null, commit: { author: null, message: "" } }]
    }));

    const summary = await new GitHubClient(undefined).getCommitHistorySummary(ref);

    expect(summary.commitCount).toBe(1);
    expect(summary.firstCommitDate).toBeNull();
    expect(summary.historyDays).toBe(0);
    expect(summary.authorStats.distinctAuthors).toBe(0);
  });

  it("handles an empty repo with no commits at all", async () => {
    listCommits.mockImplementation(() => ({ headers: {}, data: [] }));

    const summary = await new GitHubClient(undefined).getCommitHistorySummary(ref);

    expect(summary.commitCount).toBe(0);
    expect(summary.historyDays).toBe(0);
    expect(summary.maxSingleDayCommitShare).toBe(0);
    expect(summary.truncated).toBe(false);
  });

  it("ignores push events whose payload carries no commit count", async () => {
    listRepoEvents.mockImplementation(({ page }: { page: number }) =>
      page === 1
        ? {
            data: [
              { type: "PushEvent", created_at: "2026-01-10T00:00:00Z", payload: {} },
              { type: "PushEvent", created_at: null, payload: { distinct_size: 3 } }
            ]
          }
        : { data: [] }
    );

    const summary = await new GitHubClient(undefined).getPushEventSummary(ref);

    expect(summary.available).toBe(true);
    // The first event contributes a day but no commits; the second
    // contributes commits but has no usable timestamp.
    expect(summary.distinctPushDays).toBe(1);
    expect(summary.maxSinglePushCommitShare).toBe(1);
  });
});
