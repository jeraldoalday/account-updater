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
 * GitLab's transient failures are a shorter list than GitHub's.
 *
 * 5xx and 429 are the whole set. In particular a 403 is *not* retryable
 * here, which is the opposite of the GitHub policy: GitLab answers rate
 * limiting with 429, and reserves 403 for a token whose scopes don't cover
 * the request. Retrying that would burn the budget on a call that cannot
 * start succeeding.
 *
 * A timed-out request is also not retried. It has already waited the full
 * PROVIDER_REQUEST_TIMEOUT_MS ceiling; three more attempts would quadruple
 * the worst case a caller waits before hearing that the check failed.
 */
function isRetryable(err: unknown): boolean {
  if (err instanceof RequestTimeoutError) return false;
  const status = (err as HttpError)?.status;
  if (typeof status !== "number") return false;
  return status >= 500 || status === 429;
}

function retryAfterMs(err: unknown): number | null {
  return retryAfterSecondsToMs((err as HttpError)?.response?.headers?.["retry-after"]);
}

/**
 * Retries a GitLab API call on 5xx and 429 with exponential backoff,
 * honoring `Retry-After` when GitLab sends one (it does on 429, and the
 * value it gives is when the quota actually resets - guessing instead just
 * means being turned away again).
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = DEFAULT_RETRY_OPTIONS
): Promise<T> {
  return retrying(fn, { ...options, isRetryable, retryAfterMs });
}

/**
 * Whether a failure is evidence that GitLab itself is unavailable.
 *
 * Diverges from `isRetryable` in both directions, for the same reasons on
 * every forge: a timeout is not worth retrying (it has already waited the
 * full ceiling) but is strong evidence the upstream is not answering, and
 * rate limiting is not evidence about the upstream's health at all - the
 * quota is ours, and the caller is better served by the reset time GitLab
 * reported than by being told GitLab is down.
 */
export function isUpstreamUnavailable(err: unknown): boolean {
  if (isRateLimitError(err)) return false;
  if (err instanceof RequestTimeoutError) return true;
  const status = (err as HttpError)?.status;
  if (typeof status === "number") return status >= 500;
  return isNetworkError(err);
}
