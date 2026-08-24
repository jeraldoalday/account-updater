import { config } from "../config";
import { getJson, numericHeader, type JsonResponse } from "../net/httpJson";
import { withRetry } from "./withRetry";
import { summarizeCommitSample, type SampledCommit } from "../analysis/commitSample";
import { historySpanDays, parseCommitDate, sanitizeCommitDate } from "../analysis/commitDates";
import { apiBaseUrl } from "../providers/hosts";
import type { CommitHistorySummary, PushEventSummary, RepoRef } from "../types";

const API_PATH = "/api/v4";
const PAGE_SIZE = 100; // GitLab's per_page maximum
const COMMIT_SAMPLE_CAP = 500; // matches the GitHub client, for comparable heuristics
const PUSH_EVENT_PAGES = 3; // 300 events, same bound as the GitHub side

/** The subset of GitLab's commit object this service reads. */
interface GitLabCommit {
  id?: string;
  /** When the commit was authored, which is what the history span means. */
  authored_date?: string | null;
  created_at?: string | null;
  author_name?: string | null;
  author_email?: string | null;
  message?: string | null;
}

interface GitLabPushEvent {
  created_at?: string | null;
  action_name?: string | null;
  push_data?: { commit_count?: number | null } | null;
}

function dayKey(iso: string): string {
  return iso.slice(0, 10); // YYYY-MM-DD (UTC)
}

/**
 * GitLab identifies a project either by numeric id or by its URL-encoded
 * full path. The path is what a caller gives us, and encoding it is not
 * optional: the separating slashes have to survive as %2F or the API reads
 * "group/project" as extra path segments and 404s.
 */
export function projectId(ref: RepoRef): string {
  return encodeURIComponent(`${ref.owner}/${ref.repo}`);
}

export class GitLabClient {
  private readonly token?: string;

  constructor(token?: string) {
    // No fallback to the configured token here: the default is resolved
    // once, from the ref's provider, in evaluateEligibility(). Resolving
    // it in two places is how one of them ends up reaching for the wrong
    // forge's credential.
    this.token = token;
  }

  private url(ref: RepoRef, path: string, query: Record<string, string>): string {
    const search = new URLSearchParams(query).toString();
    return `${apiBaseUrl(ref.provider)}${API_PATH}/projects/${projectId(ref)}${path}?${search}`;
  }

  private headers(): Record<string, string> {
    // PRIVATE-TOKEN rather than an Authorization header: it is the form
    // GitLab accepts for both personal and project access tokens, which is
    // what GITLAB_TOKEN documents, and it works on every GitLab version
    // this could point at.
    return this.token ? { "private-token": this.token } : {};
  }

  private get<T>(
    ref: RepoRef,
    path: string,
    query: Record<string, string>
  ): Promise<JsonResponse<T>> {
    return withRetry(() =>
      getJson<T>(this.url(ref, path, query), {
        headers: this.headers(),
        timeoutMs: config.providerRequestTimeoutMs
      })
    );
  }

  /**
   * Exact commit count plus the day/author/message distributions the
   * active-development heuristics score against.
   *
   * The count comes from GitLab's `x-total` pagination header rather than
   * from paging through every commit - the same trick the GitHub client
   * plays with the Link header, for the same reason: a repo with 40,000
   * commits must not cost 400 API calls to count. GitLab drops that header
   * on very large result sets, and the fallback below is deliberate rather
   * than an oversight; see `countFromSample`.
   */
  async getCommitHistorySummary(ref: RepoRef): Promise<CommitHistorySummary> {
    const firstPage = await this.get<GitLabCommit[]>(ref, "/repository/commits", {
      per_page: "1",
      page: "1"
    });

    const totalFromHeader = numericHeader(firstPage.headers, "x-total");
    const totalPages = numericHeader(firstPage.headers, "x-total-pages");
    // Sanitized rather than passed through: a commit can carry an
    // unparseable date, and the checks downstream must not receive one
    // dressed up as a real timestamp.
    const lastCommitDate = commitDate(firstPage.data[0]);

    const pagesToFetch = Math.max(
      1,
      Math.min(
        Math.ceil((totalFromHeader ?? COMMIT_SAMPLE_CAP) / PAGE_SIZE),
        COMMIT_SAMPLE_CAP / PAGE_SIZE
      )
    );

    // Every call below is independent once the page count is known, so
    // they go out together rather than one round trip at a time.
    const [oldestPage, ...samplePages] = await Promise.all([
      totalPages && totalPages > 1
        ? this.get<GitLabCommit[]>(ref, "/repository/commits", {
            per_page: "1",
            page: String(totalPages)
          })
        : null,
      ...Array.from({ length: pagesToFetch }, (_, i) =>
        this.get<GitLabCommit[]>(ref, "/repository/commits", {
          per_page: String(PAGE_SIZE),
          page: String(i + 1)
        })
      )
    ]);

    const sample: SampledCommit[] = [];
    for (const page of samplePages) {
      for (const commit of page.data) {
        sample.push({
          date: commit.authored_date ?? commit.created_at ?? null,
          // GitLab commits carry no stable user handle, only the git
          // author fields. Email first: a person's display name changes
          // between machines more often than their commit email does.
          authorKey: commit.author_email ?? commit.author_name ?? null,
          message: commit.message ?? ""
        });
      }
    }

    const commitCount = totalFromHeader ?? sample.length;
    const firstCommitDate =
      commitDate(oldestPage?.data[0]) ?? oldestSampledDate(sample) ?? lastCommitDate;

    const { commitsByDay, distinctCommitDays, maxSingleDayCommitShare, authorStats, messageStats } =
      summarizeCommitSample(sample);

    return {
      commitCount,
      firstCommitDate,
      lastCommitDate,
      historyDays: historySpanDays(firstCommitDate, lastCommitDate),
      commitsByDay,
      distinctCommitDays,
      maxSingleDayCommitShare,
      authorStats,
      messageStats,
      truncated: sample.length < commitCount
    };
  }

  /**
   * Recent push cadence, as the secondary "was this all pushed at once?"
   * signal.
   *
   * Best-effort by the RepoProvider contract, and GitLab gives several
   * reasons to need that: the events endpoint requires `read_api` even on
   * a public project, a token without it gets a 403, and a project with no
   * recorded activity simply returns an empty list. All of those mean "no
   * signal", not "the check failed", so they report `available: false`
   * rather than throwing.
   */
  async getPushEventSummary(ref: RepoRef): Promise<PushEventSummary> {
    const pushDays = new Set<string>();
    let totalPushedCommits = 0;
    let maxSinglePushCommits = 0;
    let sawAnyEvent = false;

    for (let page = 1; page <= PUSH_EVENT_PAGES; page++) {
      let response: JsonResponse<GitLabPushEvent[]>;
      try {
        response = await this.get<GitLabPushEvent[]>(ref, "/events", {
          action: "pushed",
          per_page: String(PAGE_SIZE),
          page: String(page)
        });
      } catch {
        break;
      }

      if (response.data.length === 0) break;
      sawAnyEvent = true;

      for (const event of response.data) {
        const size = event.push_data?.commit_count ?? 0;
        totalPushedCommits += size;
        maxSinglePushCommits = Math.max(maxSinglePushCommits, size);
        if (event.created_at) pushDays.add(dayKey(event.created_at));
      }

      if (response.data.length < PAGE_SIZE) break;
    }

    return {
      available: sawAnyEvent,
      distinctPushDays: pushDays.size,
      maxSinglePushCommitShare:
        totalPushedCommits > 0 ? maxSinglePushCommits / totalPushedCommits : 0
    };
  }
}

function commitDate(commit: GitLabCommit | undefined): string | null {
  if (!commit) return null;
  return sanitizeCommitDate(commit.authored_date ?? commit.created_at);
}

/**
 * The oldest date in the sample, used only when GitLab withheld the page
 * count so there was no last page to ask for. It understates the history
 * span on a repo bigger than the sample - which is the safe direction to
 * be wrong in, since the span is a minimum requirement and a repo should
 * not pass it on a number the service could not actually verify.
 */
function oldestSampledDate(sample: readonly SampledCommit[]): string | null {
  let oldest: string | null = null;
  let oldestMs = Infinity;
  for (const commit of sample) {
    // Compared as instants, not as strings: two ISO timestamps with
    // different UTC offsets sort lexicographically in the wrong order, and
    // commits written in different timezones are ordinary.
    const parsed = parseCommitDate(commit.date);
    if (parsed && parsed.getTime() < oldestMs) {
      oldestMs = parsed.getTime();
      oldest = commit.date;
    }
  }
  return oldest;
}
