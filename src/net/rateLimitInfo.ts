export interface RateLimitInfo {
  remaining?: number;
  resetAt?: string;
  retryAfterSeconds?: number;
}

interface ApiErrorLike {
  status?: number;
  response?: { headers?: Record<string, string> };
}

/**
 * The two spellings of the same three headers.
 *
 * GitHub has always used the `x-` prefixed names. GitLab follows the
 * IETF RateLimit-Headers draft and sends them unprefixed. Reading both
 * costs one lookup and means a caller turned away by either forge gets
 * told when to come back, instead of the answer depending on which one
 * they happened to ask about.
 */
const REMAINING_HEADERS = ["x-ratelimit-remaining", "ratelimit-remaining"];
const RESET_HEADERS = ["x-ratelimit-reset", "ratelimit-reset"];

function firstHeader(
  headers: Record<string, string>,
  names: readonly string[]
): string | undefined {
  for (const name of names) {
    if (headers[name] !== undefined) return headers[name];
  }
  return undefined;
}

function errorHeaders(err: unknown): Record<string, string> {
  return (err as ApiErrorLike)?.response?.headers ?? {};
}

/**
 * Whether an upstream API error is actually rate limiting.
 *
 * 429 is unambiguous and is what GitLab uses. The subtlety is 403: GitHub
 * uses it both for rate limiting (primary,
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
  const status = (err as ApiErrorLike)?.status;
  if (status === 429) return true;
  if (status !== 403) return false;

  const headers = errorHeaders(err);

  const remaining = Number(firstHeader(headers, REMAINING_HEADERS));
  if (Number.isFinite(remaining) && remaining <= 0) return true;
  if (headers["retry-after"] !== undefined) return true;

  // Secondary rate limiting can arrive without either header, but GitHub
  // names it in the message ("You have exceeded a secondary rate limit").
  return /rate limit/i.test(String((err as Error)?.message ?? ""));
}

/**
 * If `err` is an upstream error caused by rate limiting (GitHub's primary
 * and secondary limits both surface as 403, alongside 429 from either
 * forge), pulls the remaining quota / reset time the API reports so a
 * caller knows when it's safe to retry, instead of just seeing an opaque
 * failure. Returns null for any other kind of error, including a 403 that
 * is really a permissions failure — those must reach the caller as such,
 * not as "try again later".
 */
export function extractRateLimitInfo(err: unknown): RateLimitInfo | null {
  if (!isRateLimitError(err)) return null;

  const headers = errorHeaders(err);

  const remaining = numberOrUndefined(firstHeader(headers, REMAINING_HEADERS));
  const resetSeconds = numberOrUndefined(firstHeader(headers, RESET_HEADERS));
  const retryAfterSeconds = numberOrUndefined(headers["retry-after"]);

  return {
    remaining,
    // An unparseable reset would otherwise become "Invalid Date", which is
    // a worse answer than saying nothing about when the quota returns.
    resetAt: resetSeconds !== undefined ? new Date(resetSeconds * 1000).toISOString() : undefined,
    retryAfterSeconds
  };
}

/**
 * A header as a number, or undefined when it is absent or not one. The
 * retry-after value reaches a Retry-After response header and the reset
 * value reaches a Date constructor; NaN in either place produces output
 * that looks like information and isn't.
 */
function numberOrUndefined(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
