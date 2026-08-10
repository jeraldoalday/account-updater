import { GitHubClient } from "../github/client";
import { withShallowClone } from "../clone/tempClone";
import { scanSource } from "../analysis/sourceScan";
import { checkLanguage } from "./checks/language";
import { checkSize } from "./checks/size";
import { checkHistory } from "./checks/history";
import { checkActiveDevelopment } from "./checks/activity";
import { TtlCache } from "../cache/ttlCache";
import { config } from "../config";
import { metrics } from "../metrics/metrics";
import type { EligibilityResult, RepoRef } from "../types";

export interface EvaluateOptions {
  // Only cache results computed with the shared server token. A per-request
  // caller-supplied token (e.g. for a private repo) must never be cached
  // under a plain "owner/repo" key, or a later caller without access to
  // that repo could be served someone else's cached private-repo result.
  cacheable?: boolean;
}

const resultCache = new TtlCache<string, EligibilityResult>(config.cacheTtlMs);

async function computeEligibility(ref: RepoRef, token: string | undefined): Promise<EligibilityResult> {
  const client = new GitHubClient(token);

  const [scan, history, pushEvents] = await Promise.all([
    withShallowClone(ref, token, (dir) => scanSource(dir)),
    client.getCommitHistorySummary(ref),
    client.getPushEventSummary(ref)
  ]);

  const language = checkLanguage(scan);
  const size = checkSize(scan);
  const historyCheck = checkHistory(history);
  const activeDevelopment = checkActiveDevelopment(history, pushEvents);

  const eligible =
    language.passed && size.passed && historyCheck.passed && activeDevelopment.passed;

  metrics.recordEligibilityCheck(eligible);

  return {
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
}

export async function evaluateEligibility(
  ref: RepoRef,
  token: string | undefined,
  options: EvaluateOptions = {}
): Promise<EligibilityResult> {
  const cacheable = options.cacheable ?? true;
  const cacheKey = `${ref.owner}/${ref.repo}`;

  if (cacheable) {
    const cached = resultCache.get(cacheKey);
    if (cached) {
      metrics.recordCacheHit();
      return cached;
    }
    metrics.recordCacheMiss();
  }

  const result = await computeEligibility(ref, token);

  if (cacheable) {
    resultCache.set(cacheKey, result);
  }

  return result;
}
