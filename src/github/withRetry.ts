export interface RetryOptions {
  retries: number;
  baseDelayMs: number;
}

const DEFAULT_OPTIONS: RetryOptions = { retries: 3, baseDelayMs: 300 };

interface OctokitLikeError {
  status?: number;
  response?: { headers?: Record<string, string> };
}

// 5xx and 429 are ordinary transient failures. GitHub also reports both
// primary and secondary rate limiting as 403, so treat 403 as retryable too
// rather than trying to distinguish it from a real permissions error.
function isRetryable(err: unknown): boolean {
  const status = (err as OctokitLikeError)?.status;
  return status !== undefined && (status === 403 || status === 429 || status >= 500);
}

function retryAfterMs(err: unknown): number | null {
  const retryAfter = (err as OctokitLikeError)?.response?.headers?.["retry-after"];
  if (!retryAfter) return null;
  const seconds = Number(retryAfter);
  return Number.isFinite(seconds) ? seconds * 1000 : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retries a GitHub API call on transient failures (5xx, 429, and 403 rate
 * limiting) with exponential backoff, honoring a `Retry-After` header when
 * GitHub sends one. Non-retryable errors (404, auth failures, etc.) are
 * rethrown immediately.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = DEFAULT_OPTIONS
): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      if (attempt > options.retries || !isRetryable(err)) throw err;
      const delay = retryAfterMs(err) ?? options.baseDelayMs * 2 ** (attempt - 1);
      await sleep(delay);
    }
  }
}
