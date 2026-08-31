import { withShallowClone } from "../clone/tempClone";
import { scanSource } from "../analysis/sourceScan";
import { checkLanguage } from "./checks/language";
import { checkSize } from "./checks/size";
import { checkHistory } from "./checks/history";
import { checkActiveDevelopment } from "./checks/activity";
import { createCache } from "../cache/createCache";
import { createHistoryStore } from "../history/createHistoryStore";
import { metrics } from "../metrics/metrics";
import { createProvider } from "../providers/registry";
import { RULE_SET_FINGERPRINT } from "./ruleSet";
import { defaultTokenFor } from "../providers/credentials";
import { describeRef } from "../providers/hosts";
import type { EligibilityResult, RepoRef } from "../types";

export interface EvaluateOptions {
  // Only cache results computed with the shared server token. A per-request
  // caller-supplied token (e.g. for a private repo) must never be cached
  // under a plain "owner/repo" key, or a later caller without access to
  // that repo could be served someone else's cached private-repo result.
  cacheable?: boolean;
  // Skip the cache *read* and recompute, then store the fresh result.
  // Someone who has just fixed the thing their repo was rejected for
  // otherwise has to wait out CACHE_TTL_MS to find out, with no way to
  // ask for a real answer - and "wait ten minutes and try again" is the
  // one instruction an integration can't act on.
  refresh?: boolean;
}

const resultCache = createCache<EligibilityResult>();
// Coalesces concurrent cache-miss requests for the same repo into a single
// computeEligibility() call. Without this, a burst of requests for a repo
// that isn't cached yet (e.g. several callers checking the same new repo at
// once) would each independently clone it and hit the provider API. Scoped to
// this process only — complementary to, not a replacement for, the shared
// Redis cache backend.
const inFlight = new Map<string, Promise<EligibilityResult>>();
const historyStore = createHistoryStore();

/**
 * The cache is an optimization, not a dependency: a shared Redis backend
 * being unreachable must not take the eligibility endpoint down with it.
 * A failed read degrades to a miss and a failed write is dropped, both
 * counted and logged so the degradation is visible rather than silent.
 */
async function readCache(key: string): Promise<EligibilityResult | undefined> {
  try {
    return await resultCache.get(key);
  } catch (err) {
    metrics.recordCacheError();
    logCacheFailure("read", key, err);
    return undefined;
  }
}

async function writeCache(key: string, result: EligibilityResult): Promise<void> {
  try {
    await resultCache.set(key, result);
  } catch (err) {
    metrics.recordCacheError();
    logCacheFailure("write", key, err);
  }
}

function logCacheFailure(operation: "read" | "write", key: string, err: unknown): void {
  console.error(
    JSON.stringify({
      level: "error",
      msg: "cache_unavailable",
      operation,
      key,
      error: (err as Error).message,
      time: new Date().toISOString()
    })
  );
}

async function timedStage<T>(stage: string, fn: () => Promise<T>): Promise<T> {
  const start = process.hrtime.bigint();
  const result = await fn();
  const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
  metrics.recordStageDuration(stage, durationMs);
  return result;
}

async function computeEligibility(
  ref: RepoRef,
  token: string | undefined
): Promise<EligibilityResult> {
  // A caller-supplied token wins; otherwise the credential configured for
  // *this ref's* forge is used. Resolved here rather than at the HTTP
  // layer, which cannot default a token without knowing which forge it
  // would be sent to - see defaultTokenFor().
  const effectiveToken = token ?? defaultTokenFor(ref.provider);

  // Throws UnsupportedProviderError for a forge that parses but has no
  // implementation yet - before any clone or API work is started, so an
  // unsupported ref costs nothing.
  const provider = createProvider(ref.provider, effectiveToken);
  const overallStart = process.hrtime.bigint();

  const [scan, history, pushEvents] = await Promise.all([
    timedStage("cloneAndScan", () =>
      withShallowClone(ref, effectiveToken, (dir) => scanSource(dir))
    ),
    timedStage("commitHistory", () => provider.getCommitHistorySummary(ref)),
    timedStage("pushEvents", () => provider.getPushEventSummary(ref))
  ]);

  // Diagnoses which stage a slow check spent its time in, since the three
  // calls above run concurrently and a naive "total request time" figure
  // alone can't tell you that apart (e.g. a huge repo's clone vs. a slow
  // provider API response - and Bitbucket's history call walks pages in
  // sequence, so it is the slowest of the three by construction).
  console.log(
    JSON.stringify({
      level: "info",
      msg: "eligibility_check_timing",
      repo: describeRef(ref),
      skippedLargeFiles: scan.skippedLargeFiles,
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

  metrics.recordEligibilityCheck(eligible, ref.provider);

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

/**
 * The key a repo's verdict is cached under.
 *
 * Provider-scoped, because "acme/widgets" on two forges are two different
 * projects and a shared Redis cache must not serve one for the other. And
 * rule-set-scoped, because a verdict is only meaningful alongside the
 * thresholds and language list that produced it - see RULE_SET_FINGERPRINT
 * for what goes wrong without it.
 */
export function cacheKeyFor(ref: RepoRef): string {
  return `${RULE_SET_FINGERPRINT}/${ref.provider}/${ref.owner}/${ref.repo}`;
}

export async function evaluateEligibility(
  ref: RepoRef,
  token: string | undefined,
  options: EvaluateOptions = {}
): Promise<EligibilityResult> {
  const cacheable = options.cacheable ?? true;
  const refresh = options.refresh ?? false;
  const cacheKey = cacheKeyFor(ref);

  if (!cacheable) {
    return computeEligibility(ref, token);
  }

  if (refresh) {
    metrics.recordCacheRefresh();
  } else {
    const cached = await readCache(cacheKey);
    if (cached) {
      metrics.recordCacheHit();
      return cached;
    }
    metrics.recordCacheMiss();
  }

  // Joined even on a refresh: an in-flight entry is always a computation
  // that started after this request's own decision to bypass the cache,
  // so it is as fresh as recomputing would be - and joining it is what
  // stops a burst of refreshes for one repo from becoming a burst of
  // clones.
  const existing = inFlight.get(cacheKey);
  if (existing) {
    return existing;
  }

  const pending = computeEligibility(ref, token)
    .then(async (result) => {
      await writeCache(cacheKey, result);
      return result;
    })
    .finally(() => inFlight.delete(cacheKey));

  inFlight.set(cacheKey, pending);
  return pending;
}
