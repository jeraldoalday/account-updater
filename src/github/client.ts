import { Octokit } from "@octokit/rest";
import type { CommitHistorySummary, PushEventSummary, RepoRef } from "../types";
import { withRetry } from "./withRetry";
import { summarizeCommitSample, type SampledCommit } from "../analysis/commitSample";
import { historySpanDays, sanitizeCommitDate } from "../analysis/commitDates";
import { resolveOctokitAuth } from "./octokitAuth";
import { config } from "../config";

const COMMIT_SAMPLE_CAP = 500; // pages of 100, used for the day/author/message distributions
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
    this.octokit = new Octokit(resolveOctokitAuth(token, config.githubAppAuthConfig));
  }

  async getCommitHistorySummary(ref: RepoRef): Promise<CommitHistorySummary> {
    const { owner, repo } = ref;

    // Cheap trick: per_page=1 makes the Link header's "last" page number
    // equal to the exact total commit count, without paginating everything.
    const firstPageResp = await withRetry(() =>
      this.octokit.rest.repos.listCommits({
        owner,
        repo,
        per_page: 1,
        page: 1
      })
    );
    const totalFromLink = parseLastPage(firstPageResp.headers.link as string | undefined);
    const commitCount = totalFromLink ?? firstPageResp.data.length;
    // Sanitized rather than passed through: a commit can carry an
    // unparseable author date, and the checks downstream must not receive
    // one dressed up as a real timestamp.
    const lastCommitDate = sanitizeCommitDate(firstPageResp.data[0]?.commit?.author?.date);

    // The oldest-commit lookup and the sample pages below are all
    // independent GitHub calls once `commitCount` is known - fire them
    // concurrently instead of one round-trip at a time. The exact page
    // count already comes from the Link header, so there's no need to fetch
    // sequentially just to detect "ran out of pages" (a `# < 100` page still
    // happens if the true count changes between calls, e.g. new commits
    // landing mid-check; the sample simply reflects what came back).
    const pagesToFetch = Math.max(
      Math.min(Math.ceil(commitCount / 100), COMMIT_SAMPLE_CAP / 100),
      1
    );

    const [oldestPageResp, ...pageResps] = await Promise.all([
      totalFromLink
        ? withRetry(() =>
            this.octokit.rest.repos.listCommits({ owner, repo, per_page: 1, page: totalFromLink })
          )
        : null,
      ...Array.from({ length: pagesToFetch }, (_, i) =>
        withRetry(() =>
          this.octokit.rest.repos.listCommits({ owner, repo, per_page: 100, page: i + 1 })
        )
      )
    ]);

    const firstCommitDate =
      sanitizeCommitDate(oldestPageResp?.data[0]?.commit?.author?.date) ?? lastCommitDate;

    // Sample recent commits to build the day/author/message distributions
    // used by the active-development heuristics. Bounded so huge repos stay
    // cheap - see COMMIT_SAMPLE_CAP.
    const sample: SampledCommit[] = [];
    for (const resp of pageResps) {
      for (const c of resp.data) {
        sample.push({
          date: c.commit?.author?.date ?? null,
          // Prefer the stable GitHub login over the free-text git author
          // name/email, which can vary commit-to-commit for the same person.
          authorKey: c.author?.login ?? c.commit?.author?.email ?? c.commit?.author?.name ?? null,
          message: c.commit?.message ?? ""
        });
      }
    }

    const { commitsByDay, distinctCommitDays, maxSingleDayCommitShare, authorStats, messageStats } =
      summarizeCommitSample(sample);

    const historyDays = historySpanDays(firstCommitDate, lastCommitDate);

    return {
      commitCount,
      firstCommitDate,
      lastCommitDate,
      historyDays,
      commitsByDay,
      distinctCommitDays,
      maxSingleDayCommitShare,
      authorStats,
      messageStats,
      truncated: sample.length < commitCount
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
        resp = await withRetry(() =>
          this.octokit.rest.activity.listRepoEvents({
            owner,
            repo,
            per_page: 100,
            page
          })
        );
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
