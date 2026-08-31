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

/**
 * An evaluation currently running, so concurrent requests for the same
 * repo can share it instead of each cloning independently.
 *
 * `startedAt` is what makes the entry safe to share. A computation is only
 * as current as the moment it began reading the repo, and a refresh is a
 * request for an answer that reflects the repo *now* - so the two have to
 * be comparable. See evaluateEligibility().
 */
interface InFlightEvaluation {
  startedAt: number;
  promise: Promise<EligibilityResult>;
}

// Coalesces concurrent cache-miss requests for the same repo into a single
// computeEligibility() call. Without this, a burst of requests for a repo
// that isn't cached yet (e.g. several callers checking the same new repo at
// once) would each independently clone it and hit the provider API. Scoped to
// this process only — complementary to, not a replacement for, the shared
// Redis cache backend.
const inFlight = new Map<string, InFlightEvaluation>();
const historyStore = createHistoryStore();

/**
 * How much earlier than a refresh request an already-running evaluation
 * may have started and still be allowed to answer it.
 *
 * Small enough that nothing a caller could have pushed in between fits
 * inside it, and large enough that a burst of refreshes arriving in the
 * same instant shares one clone instead of racing the clock's resolution.
 * Well under the time any real clone takes, which is the case this is
 * protecting against.
 */
const REFRESH_JOIN_GRACE_MS = 250;

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
  // Taken before anything is awaited: this is "when the caller asked", and
  // it is what a running evaluation's start time gets compared against
  // below.
  const requestedAt = Date.now();

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

  // A plain request joins whatever is already running: it would have
  // accepted a cached result up to CACHE_TTL_MS old, so an evaluation that
  // started moments ago is strictly fresher than what it asked for.
  //
  // A refresh is a different question. It means "the thing you rejected
  // this repo for is fixed - look again", so it is only answerable by work
  // that began after the caller said so. An evaluation already running when
  // the request arrived may have cloned the repo, or read its commit
  // history, before the fix landed; handing that back tells the caller
  // their fix didn't work. On a large repo the two calls can be a minute
  // apart, which is exactly the window a caller who just pushed a fix is
  // in.
  //
  // "After the caller said so" is given a small grace rather than read to
  // the millisecond, so that refreshes arriving together still coalesce
  // into one clone. Requests within a fraction of a second of each other
  // are one burst - a client retrying, or several callers reacting to the
  // same push - and cannot be on opposite sides of the fix that prompted
  // them. Work older than that could be, so it is recomputed.
  const existing = inFlight.get(cacheKey);
  if (existing && (!refresh || existing.startedAt >= requestedAt - REFRESH_JOIN_GRACE_MS)) {
    return existing.promise;
  }

  // Recorded before the work begins, not after, so it is a lower bound on
  // how current the answer can be. Stamping it afterwards would let a
  // refresh that arrived while the clone was already underway read as
  // having arrived first, and join the very work it must not.
  const startedAt = Date.now();
  const pending: Promise<EligibilityResult> = computeEligibility(ref, token)
    .then(async (result) => {
      await writeCache(cacheKey, result);
      return result;
    })
    .finally(() => {
      // Only if this evaluation is still the current one. A refresh that
      // declined to join replaces the map entry, and an unconditional
      // delete here would let the older evaluation finishing afterwards
      // remove the newer one - leaving every request behind it to start
      // its own clone.
      if (inFlight.get(cacheKey)?.promise === pending) inFlight.delete(cacheKey);
    });

  inFlight.set(cacheKey, { startedAt, promise: pending });
  return pending;
}
