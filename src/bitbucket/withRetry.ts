import { HttpError, RequestTimeoutError } from "../net/httpJson";
import { isNetworkError } from "../net/networkErrors";
import { isRateLimitError } from "../net/rateLimitInfo";
import {
  DEFAULT_RETRY_OPTIONS,
  retrying,
  retryAfterSecondsToMs,
  type RetryOptions
} from "../net/retry";

/**
 * Bitbucket's transient failures, which are not quite either of the other
 * two forges' lists.
 *
 * 5xx and 429 are retryable, as everywhere. The differences are at the
 * edges:
 *
 * - 403 is never retried. Bitbucket answers rate limiting with 429 and
 *   reserves 403 for a token whose scopes don't cover the request, so this
 *   matches the GitLab policy rather than GitHub's - where a 403 has to be
 *   inspected because it means both things.
 * - 401 is never retried either, and is called out separately because it is
 *   the failure a misconfigured BITBUCKET_TOKEN actually produces:
 *   Bitbucket rejects an unknown or revoked token with 401 where GitLab
 *   would say 403. Retrying it three times turns an instant, legible
 *   "your token is wrong" into a slow one.
 *
 * A timed-out request is not retried, for the same reason as on the other
 * providers: it has already waited the full PROVIDER_REQUEST_TIMEOUT_MS
 * ceiling, and further attempts multiply the worst case a caller waits
 * before hearing that the check failed.
 */
function isRetryable(err: unknown): boolean {
  if (err instanceof RequestTimeoutError) return false;
  const status = (err as HttpError)?.status;
  if (typeof status !== "number") return false;
  if (status === 401 || status === 403) return false;
  return status >= 500 || status === 429;
}

function retryAfterMs(err: unknown): number | null {
  return retryAfterSecondsToMs((err as HttpError)?.response?.headers?.["retry-after"]);
}

/**
 * Retries a Bitbucket API call on 5xx and 429 with exponential backoff,
 * honoring `Retry-After` when Bitbucket sends one.
 *
 * It does not always send one - Bitbucket's rate limiting is documented as
 * a rolling hourly window and it often answers 429 with no hint at all -
 * which is exactly why the backoff schedule stays the fallback rather than
 * the header being treated as required.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = DEFAULT_RETRY_OPTIONS
): Promise<T> {
  return retrying(fn, { ...options, isRetryable, retryAfterMs });
}

/**
 * Whether a failure is evidence that Bitbucket itself is unavailable.
 *
 * The same shape as the other two forges' policies. Worth noting for this
 * one: a 401 from a revoked BITBUCKET_TOKEN must not count. It is a
 * configuration mistake that will fail identically forever, and letting it
 * open a breaker would report a credential problem as an outage - sending
 * an operator to Bitbucket's status page instead of to their own
 * environment.
 */
export function isUpstreamUnavailable(err: unknown): boolean {
  if (isRateLimitError(err)) return false;
  if (err instanceof RequestTimeoutError) return true;
  const status = (err as HttpError)?.status;
  if (typeof status === "number") return status >= 500;
  return isNetworkError(err);
}
