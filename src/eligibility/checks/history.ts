import { THRESHOLDS } from "../thresholds";
import type { CheckResult, CommitHistorySummary } from "../../types";

export function checkHistory(
  history: CommitHistorySummary
): CheckResult & {
  commitCount: number;
  historyDays: number;
  firstCommitDate: string | null;
  lastCommitDate: string | null;
} {
  const reasons: string[] = [];

  if (history.commitCount < THRESHOLDS.minCommits) {
    reasons.push(`Only ${history.commitCount} commits found (need at least ${THRESHOLDS.minCommits}).`);
  }
  if (history.historyDays < THRESHOLDS.minHistoryDays) {
    reasons.push(
      `Commit history spans only ${history.historyDays} day(s) (need at least ${THRESHOLDS.minHistoryDays}).`
    );
  }

  return {
    passed: reasons.length === 0,
    commitCount: history.commitCount,
    historyDays: history.historyDays,
    firstCommitDate: history.firstCommitDate,
    lastCommitDate: history.lastCommitDate,
    reasons
  };
}
