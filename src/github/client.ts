import { Octokit } from "@octokit/rest";
import type { CommitHistorySummary, PushEventSummary, RepoRef } from "../types";

const COMMIT_SAMPLE_CAP = 500; // pages of 100, used for the day-distribution histogram
const PUSH_EVENT_CAP = 300; // GitHub only retains ~90 days / 300 events anyway

function dayKey(iso: string): string {
  return iso.slice(0, 10); // YYYY-MM-DD (UTC)
}

function parseLastPage(linkHeader: string | undefined): number | null {
  if (!linkHeader) return null;
  const match = linkHeader
    .split(",")
    .map((part) => part.trim())
    .find((part) => part.endsWith('rel="last"'));
  if (!match) return null;
  const pageMatch = match.match(/[?&]page=(\d+)/);
  return pageMatch ? Number(pageMatch[1]) : null;
}

export class GitHubClient {
  private octokit: Octokit;

  constructor(token?: string) {
    this.octokit = new Octokit(token ? { auth: token } : {});
  }

  async getCommitHistorySummary(ref: RepoRef): Promise<CommitHistorySummary> {
    const { owner, repo } = ref;

    // Cheap trick: per_page=1 makes the Link header's "last" page number
    // equal to the exact total commit count, without paginating everything.
    const firstPageResp = await this.octokit.rest.repos.listCommits({
      owner,
      repo,
      per_page: 1,
      page: 1
    });
    const totalFromLink = parseLastPage(firstPageResp.headers.link as string | undefined);
    const commitCount = totalFromLink ?? firstPageResp.data.length;
    const lastCommitDate = firstPageResp.data[0]?.commit?.author?.date ?? null;

    let firstCommitDate = lastCommitDate;
    if (totalFromLink) {
      const oldestPageResp = await this.octokit.rest.repos.listCommits({
        owner,
        repo,
        per_page: 1,
        page: totalFromLink
      });
      firstCommitDate = oldestPageResp.data[0]?.commit?.author?.date ?? firstCommitDate;
    }

    // Sample recent commits to build a day-of-commit histogram for the
    // active-development heuristic. Bounded so huge repos stay cheap.
    const commitsByDay: Record<string, number> = {};
    let sampled = 0;
    const pagesToFetch = Math.min(Math.ceil(commitCount / 100), COMMIT_SAMPLE_CAP / 100);
    for (let page = 1; page <= Math.max(pagesToFetch, 1); page++) {
      const resp = await this.octokit.rest.repos.listCommits({
        owner,
        repo,
        per_page: 100,
        page
      });
      if (resp.data.length === 0) break;
      for (const c of resp.data) {
        const date = c.commit?.author?.date;
        if (!date) continue;
        commitsByDay[dayKey(date)] = (commitsByDay[dayKey(date)] ?? 0) + 1;
        sampled++;
      }
      if (resp.data.length < 100) break;
    }

    const distinctCommitDays = Object.keys(commitsByDay).length;
    const maxDayCount = Math.max(0, ...Object.values(commitsByDay));
    const maxSingleDayCommitShare = sampled > 0 ? maxDayCount / sampled : 0;

    const historyDays =
      firstCommitDate && lastCommitDate
        ? Math.max(
            0,
            Math.round(
              (new Date(lastCommitDate).getTime() - new Date(firstCommitDate).getTime()) /
                (1000 * 60 * 60 * 24)
            )
          )
        : 0;

    return {
      commitCount,
      firstCommitDate,
      lastCommitDate,
      historyDays,
      commitsByDay,
      distinctCommitDays,
      maxSingleDayCommitShare,
      truncated: sampled < commitCount
    };
  }

  async getPushEventSummary(ref: RepoRef): Promise<PushEventSummary> {
    const { owner, repo } = ref;
    const pushDays = new Set<string>();
    let totalPushedCommits = 0;
    let maxSinglePushCommits = 0;
    let fetched = 0;
    let sawAnyEvent = false;

    for (let page = 1; page <= PUSH_EVENT_CAP / 100; page++) {
      let resp;
      try {
        resp = await this.octokit.rest.activity.listRepoEvents({
          owner,
          repo,
          per_page: 100,
          page
        });
      } catch {
        // Events API can 404/be unavailable for some repos (e.g. no public
        // activity yet); treat as "no signal" rather than failing the check.
        break;
      }
      if (resp.data.length === 0) break;
      sawAnyEvent = true;
      for (const event of resp.data) {
        fetched++;
        if (event.type !== "PushEvent") continue;
        const payload = event.payload as { distinct_size?: number; commits?: unknown[] };
        const size = payload.distinct_size ?? payload.commits?.length ?? 0;
        totalPushedCommits += size;
        maxSinglePushCommits = Math.max(maxSinglePushCommits, size);
        if (event.created_at) pushDays.add(dayKey(event.created_at));
      }
      if (resp.data.length < 100) break;
    }

    return {
      available: sawAnyEvent && fetched > 0,
      distinctPushDays: pushDays.size,
      maxSinglePushCommitShare:
        totalPushedCommits > 0 ? maxSinglePushCommits / totalPushedCommits : 0
    };
  }
}
