export interface RetryOptions {
  retries: number;
  baseDelayMs: number;
}

export interface RetryPolicy extends RetryOptions {
  /**
   * Whether a thrown error is worth another attempt. Provider-specific:
   * every forge has its own opinion about which status codes mean "the
   * request was bad" versus "we were busy", and a shared guess would get
   * one of them wrong.
   */
  isRetryable(err: unknown): boolean;
  /**
   * How long the forge asked us to wait, in milliseconds, or null when it
   * said nothing. Honoring this instead of the backoff schedule is the
   * difference between retrying when the quota is actually back and
   * retrying three times into the same closed door.
   */
  retryAfterMs?(err: unknown): number | null;
}

export const DEFAULT_RETRY_OPTIONS: RetryOptions = { retries: 3, baseDelayMs: 300 };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The retry loop itself - exponential backoff, a bounded attempt count, and
 * a `Retry-After` override - with no knowledge of which forge it is talking
 * to.
 *
 * This used to live in src/github and key off Octokit's error shape. A
 * second provider needs exactly the same loop and a different opinion about
 * what "transient" means, and the two things are worth separating: the
 * scheduling is generic, the classification is not. Provider modules supply
 * the policy (see src/github/withRetry.ts, src/gitlab/withRetry.ts) so the
 * decision about, say, whether a 403 is rate limiting stays next to the API
 * that produces it.
 */
export async function retrying<T>(fn: () => Promise<T>, policy: RetryPolicy): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      if (attempt > policy.retries || !policy.isRetryable(err)) throw err;
      const requested = policy.retryAfterMs?.(err) ?? null;
      await sleep(requested ?? policy.baseDelayMs * 2 ** (attempt - 1));
    }
  }
}

/**
 * `Retry-After` as milliseconds, for the forges that send it as a plain
 * seconds count (both GitHub and GitLab do). A non-numeric value - the
 * HTTP-date form, or junk - is ignored rather than turned into NaN, which
 * would make `sleep(NaN)` fire immediately and quietly defeat the wait.
 */
export function retryAfterSecondsToMs(value: string | undefined): number | null {
  // A blank header is the forge saying nothing, but `Number("")` is 0 -
  // which would read as "retry right now" and defeat the backoff entirely.
  if (value === undefined || value.trim() === "") return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}
