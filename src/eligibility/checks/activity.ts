import { THRESHOLDS } from "../thresholds";
import type { CheckResult, CommitHistorySummary, PushEventSummary } from "../../types";

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

// Scores how spread out commits are across calendar days: full credit once
// distinctCommitDays clears the minimum, degrading smoothly (rather than a
// hard cliff) as either the day count drops or one day dominates the share.
function scoreDaySpread(history: CommitHistorySummary): number {
  const daysScore = clamp01(history.distinctCommitDays / THRESHOLDS.minDistinctCommitDays);
  const shareScore =
    history.maxSingleDayCommitShare <= THRESHOLDS.maxSingleDayCommitShare
      ? 1
      : clamp01(
          1 -
            (history.maxSingleDayCommitShare - THRESHOLDS.maxSingleDayCommitShare) /
              (1 - THRESHOLDS.maxSingleDayCommitShare)
        );
  return (daysScore + shareScore) / 2;
}

// No push-event signal at all (common for repos with little public GitHub
// Events API history) is treated as neutral, not penalized - it just means
// this signal has nothing to contribute either way.
function scorePushBulk(pushEvents: PushEventSummary): number {
  if (!pushEvents.available) return 1;
  if (pushEvents.maxSinglePushCommitShare <= THRESHOLDS.maxSinglePushEventCommitShare) return 1;
  return clamp01(
    1 -
      (pushEvents.maxSinglePushCommitShare - THRESHOLDS.maxSinglePushEventCommitShare) /
        (1 - THRESHOLDS.maxSinglePushEventCommitShare)
  );
}

// Rewards low reuse of generic/templated messages and a wide spread of
// distinct messages - the pattern real incremental work produces.
function scoreMessageQuality(history: CommitHistorySummary): number {
  const { genericMessageShare, distinctMessageRatio } = history.messageStats;
  return clamp01((1 - genericMessageShare) * 0.6 + distinctMessageRatio * 0.4);
}

// Deliberately lenient: a single-maintainer repo is common and legitimate,
// so one author only costs a small discount rather than sinking the score.
// Additional distinct authors climb back to full credit quickly.
function scoreContributorDiversity(history: CommitHistorySummary): number {
  const { distinctAuthors } = history.authorStats;
  if (distinctAuthors <= 0) return 0.8; // no author identity available - neutral, not penalized
  return clamp01(0.8 + 0.05 * (distinctAuthors - 1));
}

export function checkActiveDevelopment(
  history: CommitHistorySummary,
  pushEvents: PushEventSummary
): CheckResult & {
  score: number;
  distinctCommitDays: number;
  maxSingleDayCommitShare: number;
  authorStats: CommitHistorySummary["authorStats"];
  messageStats: CommitHistorySummary["messageStats"];
  pushEvents: PushEventSummary;
} {
  const weights = THRESHOLDS.activeDevelopmentWeights;
  const signals = {
    daySpread: scoreDaySpread(history),
    pushBulk: scorePushBulk(pushEvents),
    messageQuality: scoreMessageQuality(history),
    contributorDiversity: scoreContributorDiversity(history)
  };

  const weightSum = Object.values(weights).reduce((sum, w) => sum + w, 0);
  const score =
    Object.entries(signals).reduce(
      (sum, [key, signalScore]) => sum + signalScore * weights[key as keyof typeof weights],
      0
    ) / weightSum;

  const reasons: string[] = [];
  if (signals.daySpread < 0.8) {
    reasons.push(
      `Commits are concentrated on only ${history.distinctCommitDays} distinct day(s), with ` +
        `${Math.round(history.maxSingleDayCommitShare * 100)}% landing on the single busiest day.`
    );
  }
  if (signals.pushBulk < 0.8) {
    reasons.push(
      `A single push event delivered ${Math.round(pushEvents.maxSinglePushCommitShare * 100)}% of ` +
        `recently observed commits at once, suggesting locally-built history pushed all at once.`
    );
  }
  if (signals.messageQuality < 0.8) {
    reasons.push(
      `Commit messages lean heavily on generic/templated text (${Math.round(history.messageStats.genericMessageShare * 100)}% ` +
        `generic, only ${Math.round(history.messageStats.distinctMessageRatio * 100)}% distinct).`
    );
  }
  if (signals.contributorDiversity < 0.8) {
    reasons.push(
      `Only ${history.authorStats.distinctAuthors} distinct contributor(s) found in the sampled history.`
    );
  }

  const passed = score >= THRESHOLDS.minActiveDevelopmentScore;
  if (!passed) {
    reasons.push(
      `Active-development score ${score.toFixed(2)} is below the required ` +
        `${THRESHOLDS.minActiveDevelopmentScore.toFixed(2)}.`
    );
  }

  return {
    passed,
    score,
    distinctCommitDays: history.distinctCommitDays,
    maxSingleDayCommitShare: history.maxSingleDayCommitShare,
    authorStats: history.authorStats,
    messageStats: history.messageStats,
    pushEvents,
    reasons
  };
}
