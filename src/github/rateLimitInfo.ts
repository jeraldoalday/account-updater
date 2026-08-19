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
 * Whether a GitHub API error is actually rate limiting.
 *
 * The subtlety is 403: GitHub uses it both for rate limiting (primary,
 * with the remaining quota at zero; and secondary, which carries a
 * `Retry-After` and says so in the message) and for ordinary permission
 * failures - a token without access to a private repo, or one that hasn't
 * been SSO-authorized for an organization. Treating every 403 as rate
 * limiting told the caller "try again later" about a repo they will never
 * be able to read, and had the client burn its retry budget - and more
 * quota - waiting between attempts that could not succeed.
 *
 * A 403 counts as rate limiting only with positive evidence; anything
 * else is a permissions error.
 */
export function isRateLimitError(err: unknown): boolean {
  const status = (err as OctokitLikeError)?.status;
  if (status === 429) return true;
  if (status !== 403) return false;

  const headers = (err as OctokitLikeError)?.response?.headers ?? {};

  const remaining = Number(headers["x-ratelimit-remaining"]);
  if (Number.isFinite(remaining) && remaining <= 0) return true;
  if (headers["retry-after"] !== undefined) return true;

  // Secondary rate limiting can arrive without either header, but GitHub
  // names it in the message ("You have exceeded a secondary rate limit").
  return /rate limit/i.test(String((err as Error)?.message ?? ""));
}

/**
 * If `err` is a GitHub API error caused by rate limiting (primary or
 * secondary — both surface as 403, alongside 429), pulls the remaining
 * quota / reset time GitHub reports so a caller knows when it's safe to
 * retry, instead of just seeing an opaque failure. Returns null for any
 * other kind of error, including a 403 that is really a permissions
 * failure — those must reach the caller as such, not as "try again later".
 */
export function extractRateLimitInfo(err: unknown): RateLimitInfo | null {
  if (!isRateLimitError(err)) return null;

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
