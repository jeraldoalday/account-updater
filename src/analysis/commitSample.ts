import { parseCommitDate } from "./commitDates";
import { summarizeCommitMessages } from "./commitMessagePatterns";

export interface SampledCommit {
  date: string | null;
  authorKey: string | null;
  message: string;
}

export interface AuthorStats {
  sampled: number;
  distinctAuthors: number;
  maxAuthorShare: number;
}

export interface CommitSampleSummary {
  sampled: number;
  commitsByDay: Record<string, number>;
  distinctCommitDays: number;
  maxSingleDayCommitShare: number;
  authorStats: AuthorStats;
  messageStats: ReturnType<typeof summarizeCommitMessages>;
}

function dayKey(iso: string): string {
  return iso.slice(0, 10); // YYYY-MM-DD (UTC)
}

function summarizeAuthors(authorKeys: readonly (string | null)[]): AuthorStats {
  const known = authorKeys.filter((key): key is string => Boolean(key));
  if (known.length === 0) {
    return { sampled: 0, distinctAuthors: 0, maxAuthorShare: 0 };
  }

  const counts = new Map<string, number>();
  for (const key of known) {
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const maxCount = Math.max(...counts.values());

  return {
    sampled: known.length,
    distinctAuthors: counts.size,
    maxAuthorShare: maxCount / known.length
  };
}

// Turns a page-sampled batch of commits (bounded for cost - every client
// has its own COMMIT_SAMPLE_CAP) into the day/author/message distributions
// the active-development heuristics score against. Kept pure and separate
// from the code that calls a provider API, so it is testable without
// mocking any of them - and so all three forges are summarized by the same
// arithmetic rather than by three near-copies of it.
export function summarizeCommitSample(commits: readonly SampledCommit[]): CommitSampleSummary {
  const commitsByDay: Record<string, number> = {};
  let sampled = 0;

  for (const commit of commits) {
    // Skip unparseable dates rather than bucketing them: dayKey() would
    // turn each distinct piece of garbage into its own "day", inflating the
    // distinct-day count that the organic-development score rewards.
    if (!commit.date || !parseCommitDate(commit.date)) continue;
    const key = dayKey(commit.date);
    commitsByDay[key] = (commitsByDay[key] ?? 0) + 1;
    sampled++;
  }

  const distinctCommitDays = Object.keys(commitsByDay).length;
  const maxDayCount = Math.max(0, ...Object.values(commitsByDay));
  const maxSingleDayCommitShare = sampled > 0 ? maxDayCount / sampled : 0;

  return {
    sampled,
    commitsByDay,
    distinctCommitDays,
    maxSingleDayCommitShare,
    authorStats: summarizeAuthors(commits.map((c) => c.authorKey)),
    messageStats: summarizeCommitMessages(commits.map((c) => c.message))
  };
}
