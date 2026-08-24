import { config } from "../config";
import { getJson, type JsonResponse } from "../net/httpJson";
import { withRetry } from "./withRetry";
import { summarizeCommitSample, type SampledCommit } from "../analysis/commitSample";
import { historySpanDays, parseCommitDate, sanitizeCommitDate } from "../analysis/commitDates";
import { apiBaseUrl } from "../providers/hosts";
import type { CommitHistorySummary, PushEventSummary, RepoRef } from "../types";

const API_PATH = "/2.0";
const PAGE_SIZE = 100; // Bitbucket's pagelen maximum on the commits endpoint
const COMMIT_SAMPLE_CAP = 500; // matches the other clients, for comparable heuristics

/**
 * Bitbucket returns the whole commit object by default - diffstat links,
 * participant lists, rendered markup - and none of it is read here. Asking
 * for only the fields used cuts a 100-commit page from megabytes to a few
 * kilobytes, which matters because these pages are fetched one after
 * another rather than concurrently (see below).
 *
 * `next` is included deliberately: without it the pagination link is
 * filtered out along with everything else, and the walk stops after one
 * page while reporting a confident, wrong commit count.
 */
const COMMIT_FIELDS = [
  "next",
  "values.hash",
  "values.date",
  "values.message",
  "values.author.raw",
  "values.author.user.nickname"
].join(",");

/** The subset of Bitbucket's commit object this service reads. */
interface BitbucketCommit {
  hash?: string;
  /** Commit timestamp, e.g. "2026-06-01T10:00:00+00:00". */
  date?: string | null;
  message?: string | null;
  author?: {
    /** Git's own author line, "Some One <someone@example.test>". */
    raw?: string | null;
    /** Present only when the commit email maps to a Bitbucket account. */
    user?: { nickname?: string | null } | null;
  } | null;
}

interface BitbucketPage<T> {
  values?: T[];
  /** Absolute URL of the next page, absent on the last one. */
  next?: string | null;
}

/**
 * Bitbucket addresses a repo as `{workspace}/{repo_slug}`, both as plain
 * path segments. Encoded per segment rather than as one string: a slash
 * here would be a second path segment, and the ref validation upstream
 * already guarantees there isn't one - this keeps that true even if a
 * looser ref ever reaches the client.
 */
export function repoPath(ref: RepoRef): string {
  return `${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`;
}

/**
 * Extracts a stable identity for a commit's author.
 *
 * The Bitbucket account nickname is preferred when the commit email is
 * linked to an account, because it survives someone committing from a
 * second machine with a different git identity. Failing that, the email
 * out of the raw author line - a person's display name changes more often
 * than their commit email does - and failing that, the raw line itself.
 */
export function authorKeyOf(commit: BitbucketCommit): string | null {
  const nickname = commit.author?.user?.nickname;
  if (nickname) return nickname;

  const raw = commit.author?.raw;
  if (!raw) return null;
  const email = raw.match(/<([^>]+)>/);
  return email ? email[1] : raw.trim() || null;
}

export class BitbucketClient {
  private readonly token?: string;

  constructor(token?: string) {
    // No fallback to the configured token here, for the same reason as on
    // the other clients: the default is resolved once, from the ref's
    // provider, in evaluateEligibility(). Two places resolving it is how
    // one of them ends up reaching for the wrong forge's credential.
    this.token = token;
  }

  private headers(): Record<string, string> {
    // Bearer, which is what Bitbucket accepts for repository, project, and
    // workspace access tokens as well as for OAuth tokens. The older app
    // passwords use Basic instead; BITBUCKET_TOKEN documents an access
    // token precisely so there is one scheme here rather than a guess
    // about which kind of secret arrived.
    return this.token ? { authorization: `Bearer ${this.token}` } : {};
  }

  private get<T>(url: string): Promise<JsonResponse<T>> {
    return withRetry(() =>
      getJson<T>(url, {
        headers: this.headers(),
        timeoutMs: config.providerRequestTimeoutMs
      })
    );
  }

  private commitsUrl(ref: RepoRef): string {
    const search = new URLSearchParams({
      pagelen: String(PAGE_SIZE),
      fields: COMMIT_FIELDS
    });
    return `${apiBaseUrl(ref.provider)}${API_PATH}/repositories/${repoPath(ref)}/commits?${search}`;
  }

  /**
   * Exact commit count where it can be established, plus the day/author/
   * message distributions the active-development heuristics score against.
   *
   * This costs more than the same call on the other two forges, and the
   * reason is worth stating: Bitbucket does not report a total. GitHub's
   * Link header and GitLab's `x-total` both let their clients learn the
   * commit count in one request and fan the sample pages out concurrently.
   * Bitbucket's commits endpoint is cursor-paginated - each page carries
   * only a `next` URL - so the pages must be walked in order, and the count
   * is whatever the walk finds.
   *
   * The walk is capped at COMMIT_SAMPLE_CAP commits. A repo larger than
   * that reports the cap and `truncated: true`, which understates the
   * count. That is the safe direction: the commit count is a *minimum*
   * requirement, so understating can only fail a repo that should have
   * passed, never pass one that should have failed - and the cap sits far
   * above the threshold, so in practice a repo hits the cap only once it
   * has long since satisfied the requirement.
   */
  async getCommitHistorySummary(ref: RepoRef): Promise<CommitHistorySummary> {
    const commits = await this.walkCommits(ref);

    const sample: SampledCommit[] = commits.map((commit) => ({
      date: commit.date ?? null,
      authorKey: authorKeyOf(commit),
      message: commit.message ?? ""
    }));

    // Bitbucket returns commits newest-first, but that ordering is by
    // topological walk rather than by timestamp, and a merged branch can
    // carry commits authored earlier than ones listed above them. So the
    // ends of the range are found by comparing instants rather than by
    // taking the first and last rows.
    const lastCommitDate = newestSampledDate(sample);
    const firstCommitDate = oldestSampledDate(sample);

    const { commitsByDay, distinctCommitDays, maxSingleDayCommitShare, authorStats, messageStats } =
      summarizeCommitSample(sample);

    return {
      commitCount: sample.length,
      firstCommitDate,
      lastCommitDate,
      historyDays: historySpanDays(firstCommitDate, lastCommitDate),
      commitsByDay,
      distinctCommitDays,
      maxSingleDayCommitShare,
      authorStats,
      messageStats,
      // True only when the walk stopped at the cap with more left to read:
      // unlike the other clients there is no separate total to compare
      // against, so hitting the cap *is* the signal.
      truncated: sample.length >= COMMIT_SAMPLE_CAP
    };
  }

  /**
   * Follows the cursor until the cap is reached or the pages run out.
   *
   * The `next` URL comes out of a response body, which makes it the one
   * piece of request input this service does not construct itself. It is
   * therefore checked against the origin and path the walk started from
   * before being fetched - a compromised or misconfigured upstream that
   * answered with a `next` pointing somewhere else would otherwise have
   * this service fetch it, with the caller's token attached.
   */
  private async walkCommits(ref: RepoRef): Promise<BitbucketCommit[]> {
    const start = this.commitsUrl(ref);
    const commits: BitbucketCommit[] = [];
    let url: string | null = start;

    while (url && commits.length < COMMIT_SAMPLE_CAP) {
      const page: JsonResponse<BitbucketPage<BitbucketCommit>> =
        await this.get<BitbucketPage<BitbucketCommit>>(url);
      const values = page.data.values ?? [];
      if (values.length === 0) break;

      commits.push(...values.slice(0, COMMIT_SAMPLE_CAP - commits.length));
      url = isSameEndpoint(page.data.next, start) ? (page.data.next as string) : null;
    }

    return commits;
  }

  /**
   * Push cadence, which Bitbucket does not expose.
   *
   * GitHub has an events API and GitLab has one too; Bitbucket Cloud has
   * no equivalent for a repository - push activity is delivered to
   * webhooks as it happens and is never queryable afterwards. There is no
   * approximation worth making here either: reusing commit timestamps
   * would not measure push cadence, it would re-measure the commit
   * distribution this service already scores, and feeding the same signal
   * in twice would quietly double its weight.
   *
   * So this reports "no signal", which the RepoProvider contract exists to
   * allow and which the active-development score treats as neutral rather
   * than as a failure. The practical effect is that a Bitbucket repo is
   * judged on the other three signals, which is the honest answer.
   */
  async getPushEventSummary(_ref: RepoRef): Promise<PushEventSummary> {
    return { available: false, distinctPushDays: 0, maxSinglePushCommitShare: 0 };
  }
}

/**
 * Whether a `next` link points at the same endpoint the walk started from.
 *
 * Compares origin and path exactly, and requires the origin to be the
 * provider's declared API host - the query string is allowed to differ
 * because the cursor lives there, and nothing else is.
 */
export function isSameEndpoint(next: string | null | undefined, start: string): boolean {
  if (!next) return false;
  let nextUrl: URL;
  let startUrl: URL;
  try {
    nextUrl = new URL(next);
    startUrl = new URL(start);
  } catch {
    return false;
  }
  return (
    nextUrl.protocol === "https:" &&
    nextUrl.origin === startUrl.origin &&
    nextUrl.pathname === startUrl.pathname
  );
}

function newestSampledDate(sample: readonly SampledCommit[]): string | null {
  return extremeSampledDate(sample, (candidate, best) => candidate > best);
}

function oldestSampledDate(sample: readonly SampledCommit[]): string | null {
  return extremeSampledDate(sample, (candidate, best) => candidate < best);
}

/**
 * The end of the sampled range in one direction, comparing instants rather
 * than strings: two ISO timestamps written in different UTC offsets sort
 * lexicographically in the wrong order, and commits authored in different
 * timezones are ordinary.
 */
function extremeSampledDate(
  sample: readonly SampledCommit[],
  isBetter: (candidate: number, best: number) => boolean
): string | null {
  let best: string | null = null;
  let bestMs = 0;
  for (const commit of sample) {
    const parsed = parseCommitDate(commit.date);
    if (!parsed) continue;
    if (best === null || isBetter(parsed.getTime(), bestMs)) {
      bestMs = parsed.getTime();
      best = sanitizeCommitDate(commit.date);
    }
  }
  return best;
}
