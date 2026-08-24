import { THRESHOLDS } from "../thresholds";
import type { CheckResult, CommitHistorySummary, PushEventSummary } from "../../types";

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * The four organic-development signals, named once so the score, the
 * weights, and the per-signal breakdown reported to the caller cannot
 * disagree about what they are.
 */
export const SIGNAL_NAMES = [
  "daySpread",
  "pushBulk",
  "messageQuality",
  "contributorDiversity"
] as const;

export type SignalName = (typeof SIGNAL_NAMES)[number];

/**
 * Each signal's score, or null for one the forge could not supply. Only
 * push cadence can be null today; the other three are derived from commit
 * history, which every provider returns.
 */
export interface SignalScores {
  daySpread: number;
  pushBulk: number | null;
  messageQuality: number;
  contributorDiversity: number;
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

// Scores bulk delivery when there is push data to score. A repo with none
// - common on GitHub, where the Events API forgets, and universal on
// Bitbucket, which has no events API at all - returns null and is left out
// of the average entirely rather than scored. See the weighting below.
function scorePushBulk(pushEvents: PushEventSummary): number | null {
  if (!pushEvents.available) return null;
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
  signals: SignalScores;
  distinctCommitDays: number;
  maxSingleDayCommitShare: number;
  authorStats: CommitHistorySummary["authorStats"];
  messageStats: CommitHistorySummary["messageStats"];
  pushEvents: PushEventSummary;
} {
  const weights = THRESHOLDS.activeDevelopmentWeights;
  const signals: SignalScores = {
    daySpread: scoreDaySpread(history),
    pushBulk: scorePushBulk(pushEvents),
    messageQuality: scoreMessageQuality(history),
    contributorDiversity: scoreContributorDiversity(history)
  };

  // Only the signals that had data are averaged, and the weights are
  // renormalized over those.
  //
  // A missing signal used to score a full 1.0, which was described as
  // treating it as neutral and is not neutral: it hands the repo the
  // signal's entire weight for free, and the blended score is then
  // compared against a fixed threshold. That made a repo with no push data
  // indistinguishable from one whose pushes looked ideal, and strictly
  // easier to pass than one with any real imperfection in them - a repo
  // could be carried over the line by a quarter of a score awarded for
  // evidence nobody had.
  //
  // That was already wrong on GitHub, where the Events API only remembers
  // recent activity; it became structural with Bitbucket, which has no
  // events API at all, so every Bitbucket repo would collect the same free
  // quarter of the score forever. Renormalizing means a repo is judged on
  // the evidence that exists, and a forge that reports less evidence
  // neither gains nor loses for it.
  const applied = SIGNAL_NAMES.filter((name) => signals[name] !== null);
  const weightSum = applied.reduce((sum, name) => sum + weights[name], 0);
  const score =
    weightSum === 0
      ? 0
      : applied.reduce((sum, name) => sum + (signals[name] as number) * weights[name], 0) /
        weightSum;

  const reasons: string[] = [];
  if (signals.daySpread < 0.8) {
    reasons.push(
      `Commits are concentrated on only ${history.distinctCommitDays} distinct day(s), with ` +
        `${Math.round(history.maxSingleDayCommitShare * 100)}% landing on the single busiest day.`
    );
  }
  if (signals.pushBulk !== null && signals.pushBulk < 0.8) {
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
    // The per-signal breakdown, so a caller can see which signal cost a
    // repo its verdict instead of only a blended number - and see a null
    // for one the forge could not supply, which is the difference between
    // "this looked bad" and "this could not be measured".
    signals,
    distinctCommitDays: history.distinctCommitDays,
    maxSingleDayCommitShare: history.maxSingleDayCommitShare,
    authorStats: history.authorStats,
    messageStats: history.messageStats,
    pushEvents,
    reasons
  };
}
