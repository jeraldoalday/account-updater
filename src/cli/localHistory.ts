import { summarizeCommitSample, type SampledCommit } from "../analysis/commitSample";
import { historySpanDays, parseCommitDate } from "../analysis/commitDates";
import type { CommitHistorySummary } from "../types";

// Turns local `git log` output into the same CommitHistorySummary shape
// GitHubClient produces from the API, so the CLI self-check can run the
// real checkActiveDevelopment/checkHistory logic instead of re-implementing
// a second, drift-prone copy of it.
export function buildLocalHistorySummary(commits: readonly SampledCommit[]): CommitHistorySummary {
  // Sorting is lexical, which is only correct for real ISO-8601 strings, so
  // anything unparseable is dropped before sorting rather than being
  // allowed to become the "first" or "last" commit date.
  const dates = commits
    .map((c) => c.date)
    .filter((d): d is string => Boolean(d) && parseCommitDate(d) !== null);
  const sortedDates = [...dates].sort();
  const firstCommitDate = sortedDates[0] ?? null;
  const lastCommitDate = sortedDates[sortedDates.length - 1] ?? null;
  const historyDays = historySpanDays(firstCommitDate, lastCommitDate);

  const { commitsByDay, distinctCommitDays, maxSingleDayCommitShare, authorStats, messageStats } =
    summarizeCommitSample(commits);

  return {
    commitCount: commits.length,
    firstCommitDate,
    lastCommitDate,
    historyDays,
    commitsByDay,
    distinctCommitDays,
    maxSingleDayCommitShare,
    authorStats,
    messageStats,
    truncated: false // local `git log` sees the entire history, unlike the API sampling cap
  };
}
