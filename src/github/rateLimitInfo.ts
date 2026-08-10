export interface RateLimitInfo {
  remaining?: number;
  resetAt?: string;
  retryAfterSeconds?: number;
}

interface OctokitLikeError {
  status?: number;
  response?: { headers?: Record<string, string> };
}

/**
 * If `err` is a GitHub API error caused by rate limiting (primary or
 * secondary — both surface as 403, alongside 429), pulls the remaining
 * quota / reset time GitHub reports so a caller knows when it's safe to
 * retry, instead of just seeing an opaque failure. Returns null for any
 * other kind of error.
 */
export function extractRateLimitInfo(err: unknown): RateLimitInfo | null {
  const status = (err as OctokitLikeError)?.status;
  if (status !== 403 && status !== 429) return null;

  const headers = (err as OctokitLikeError)?.response?.headers ?? {};

  const remainingHeader = headers["x-ratelimit-remaining"];
  const remaining = remainingHeader !== undefined ? Number(remainingHeader) : undefined;

  const resetHeader = headers["x-ratelimit-reset"];
  const resetAt =
    resetHeader !== undefined ? new Date(Number(resetHeader) * 1000).toISOString() : undefined;

  const retryAfterHeader = headers["retry-after"];
  const retryAfterSeconds = retryAfterHeader !== undefined ? Number(retryAfterHeader) : undefined;

  return { remaining, resetAt, retryAfterSeconds };
}
