import { isRateLimitError } from "./rateLimitInfo";
import {
  DEFAULT_RETRY_OPTIONS,
  retrying,
  retryAfterSecondsToMs,
  type RetryOptions
} from "../net/retry";

export type { RetryOptions };

interface OctokitLikeError {
  status?: number;
  response?: { headers?: Record<string, string> };
}

// 5xx and 429 are ordinary transient failures. A 403 is retryable only
// when it is really rate limiting: GitHub uses the same status for a token
// that simply can't see the repo, and retrying that spends the retry
// budget - and more of the caller's quota - on attempts that cannot
// succeed, delaying an error the caller could have had immediately.
function isRetryable(err: unknown): boolean {
  const status = (err as OctokitLikeError)?.status;
  if (status === undefined) return false;
  if (status >= 500) return true;
  return isRateLimitError(err);
}

function retryAfterMs(err: unknown): number | null {
  return retryAfterSecondsToMs((err as OctokitLikeError)?.response?.headers?.["retry-after"]);
}

/**
 * Retries a GitHub API call on transient failures (5xx, 429, and 403 rate
 * limiting) with exponential backoff, honoring a `Retry-After` header when
 * GitHub sends one. Non-retryable errors (404, auth failures, etc.) are
 * rethrown immediately.
 *
 * The loop lives in src/net/retry.ts; what stays here is the part that is
 * genuinely GitHub's - in particular the 403 judgement call above.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = DEFAULT_RETRY_OPTIONS
): Promise<T> {
  return retrying(fn, { ...options, isRetryable, retryAfterMs });
}
