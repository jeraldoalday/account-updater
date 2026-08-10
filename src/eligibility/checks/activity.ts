import { THRESHOLDS } from "../thresholds";
import type { CheckResult, CommitHistorySummary, PushEventSummary } from "../../types";

/**
 * Approximates "history that accrued as the work happened" vs. "built
 * locally and pushed all at once". Two independent signals:
 *
 *  1. Commit-author-date spread: real incremental work tends to land across
 *     many distinct calendar days, with no single day dominating the count.
 *  2. GitHub push events (when available, ~last 90 days): if one push event
 *     delivered most of the known commits at once, that's a strong bulk-push
 *     signal even if the commit author dates were spread out beforehand.
 */
export function checkActiveDevelopment(
  history: CommitHistorySummary,
  pushEvents: PushEventSummary
): CheckResult & {
  distinctCommitDays: number;
  maxSingleDayCommitShare: number;
  pushEvents: PushEventSummary;
} {
  const reasons: string[] = [];

  if (history.distinctCommitDays < THRESHOLDS.minDistinctCommitDays) {
    reasons.push(
      `Commits are concentrated on only ${history.distinctCommitDays} distinct day(s) ` +
        `(need at least ${THRESHOLDS.minDistinctCommitDays}).`
    );
  }
  if (history.maxSingleDayCommitShare > THRESHOLDS.maxSingleDayCommitShare) {
    reasons.push(
      `${Math.round(history.maxSingleDayCommitShare * 100)}% of sampled commits landed on a single day ` +
        `(max allowed is ${Math.round(THRESHOLDS.maxSingleDayCommitShare * 100)}%).`
    );
  }

  if (
    pushEvents.available &&
    pushEvents.maxSinglePushCommitShare > THRESHOLDS.maxSinglePushEventCommitShare
  ) {
    reasons.push(
      `A single push event delivered ${Math.round(pushEvents.maxSinglePushCommitShare * 100)}% of recently ` +
        `observed commits at once, suggesting locally-built history pushed all at once.`
    );
  }

  return {
    passed: reasons.length === 0,
    distinctCommitDays: history.distinctCommitDays,
    maxSingleDayCommitShare: history.maxSingleDayCommitShare,
    pushEvents,
    reasons
  };
}
