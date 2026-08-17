import { GitHubClient } from "../github/client";
import { withShallowClone } from "../clone/tempClone";
import { scanSource } from "../analysis/sourceScan";
import { checkLanguage } from "./checks/language";
import { checkSize } from "./checks/size";
import { checkHistory } from "./checks/history";
import { checkActiveDevelopment } from "./checks/activity";
import { createCache } from "../cache/createCache";
import { createHistoryStore } from "../history/createHistoryStore";
import { metrics } from "../metrics/metrics";
import type { EligibilityResult, RepoRef } from "../types";

export interface EvaluateOptions {
  // Only cache results computed with the shared server token. A per-request
  // caller-supplied token (e.g. for a private repo) must never be cached
  // under a plain "owner/repo" key, or a later caller without access to
  // that repo could be served someone else's cached private-repo result.
  cacheable?: boolean;
}

const resultCache = createCache<EligibilityResult>();
// Coalesces concurrent cache-miss requests for the same repo into a single
// computeEligibility() call. Without this, a burst of requests for a repo
// that isn't cached yet (e.g. several callers checking the same new repo at
// once) would each independently clone it and hit the GitHub API. Scoped to
// this process only — complementary to, not a replacement for, the shared
// Redis cache backend.
const inFlight = new Map<string, Promise<EligibilityResult>>();
const historyStore = createHistoryStore();

async function timedStage<T>(stage: string, fn: () => Promise<T>): Promise<T> {
  const start = process.hrtime.bigint();
  const result = await fn();
  const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
  metrics.recordStageDuration(stage, durationMs);
  return result;
}

async function computeEligibility(ref: RepoRef, token: string | undefined): Promise<EligibilityResult> {
  const client = new GitHubClient(token);
  const overallStart = process.hrtime.bigint();

  const [scan, history, pushEvents] = await Promise.all([
    timedStage("cloneAndScan", () => withShallowClone(ref, token, (dir) => scanSource(dir))),
    timedStage("commitHistory", () => client.getCommitHistorySummary(ref)),
    timedStage("pushEvents", () => client.getPushEventSummary(ref))
  ]);

  // Diagnoses which stage a slow check spent its time in, since the three
  // calls above run concurrently and a naive "total request time" figure
  // alone can't tell you that apart (e.g. a huge repo's clone vs. a slow
  // GitHub API response).
  console.log(
    JSON.stringify({
      level: "info",
      msg: "eligibility_check_timing",
      repo: `${ref.owner}/${ref.repo}`,
      totalMs: Number((Number(process.hrtime.bigint() - overallStart) / 1_000_000).toFixed(1)),
      time: new Date().toISOString()
    })
  );

  const language = checkLanguage(scan);
  const size = checkSize(scan);
  const historyCheck = checkHistory(history);
  const activeDevelopment = checkActiveDevelopment(history, pushEvents);

  const eligible =
    language.passed && size.passed && historyCheck.passed && activeDevelopment.passed;

  metrics.recordEligibilityCheck(eligible);

  const result: EligibilityResult = {
    eligible,
    repo: ref,
    checks: {
      language,
      size,
      history: historyCheck,
      activeDevelopment
    },
    reasons: [
      ...language.reasons,
      ...size.reasons,
      ...historyCheck.reasons,
      ...activeDevelopment.reasons
    ]
  };

  // Best-effort: an audit-trail write failure shouldn't fail the caller's
  // eligibility check.
  try {
    historyStore.record(result);
  } catch (err) {
    console.error("Failed to record evaluation history:", err);
  }

  return result;
}

export async function evaluateEligibility(
  ref: RepoRef,
  token: string | undefined,
  options: EvaluateOptions = {}
): Promise<EligibilityResult> {
  const cacheable = options.cacheable ?? true;
  const cacheKey = `${ref.owner}/${ref.repo}`;

  if (!cacheable) {
    return computeEligibility(ref, token);
  }

  const cached = await resultCache.get(cacheKey);
  if (cached) {
    metrics.recordCacheHit();
    return cached;
  }
  metrics.recordCacheMiss();

  const existing = inFlight.get(cacheKey);
  if (existing) {
    return existing;
  }

  const pending = computeEligibility(ref, token)
    .then(async (result) => {
      await resultCache.set(cacheKey, result);
      return result;
    })
    .finally(() => inFlight.delete(cacheKey));

  inFlight.set(cacheKey, pending);
  return pending;
}
