export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerOptions {
  /**
   * How many consecutive tripping failures open the circuit. Consecutive
   * rather than a rate over a window: the question this answers is "is the
   * upstream down right now", and a run of failures with no success
   * between them is the cheapest honest evidence of that. A rate would
   * also open on a steady trickle of failures mixed with successes, which
   * is a degraded upstream that is still serving - exactly the case where
   * refusing to call it makes things worse.
   */
  failureThreshold: number;
  /** How long the circuit stays open before one probe is allowed through. */
  openMs: number;
  /**
   * Whether a thrown error counts toward opening the circuit.
   *
   * Defaults to counting everything, which is almost never right. A repo
   * that doesn't exist, a token without access, a malformed ref - those
   * are answers, and an upstream that answers is up. Counting them would
   * let a run of 404s from one caller cut every other caller off from a
   * perfectly healthy forge.
   */
  shouldTrip?(err: unknown): boolean;
  /** Injectable clock, so tests don't have to wait out a cooldown. */
  now?(): number;
}

export interface CircuitSnapshot {
  name: string;
  state: CircuitState;
  consecutiveFailures: number;
  /** When the circuit last opened, ISO-8601, absent while it is closed. */
  openedAt?: string;
  /** How long until the next probe is allowed, absent unless open. */
  retryAfterMs?: number;
  /** The failure that opened it, for an operator reading /metrics. */
  lastError?: string;
}

/**
 * Thrown instead of calling the upstream while the circuit is open.
 *
 * Carries how long the caller should wait, so the HTTP layer can answer
 * with a `Retry-After` a client can act on rather than "try again later",
 * which is the instruction an integration can't do anything with.
 */
export class CircuitOpenError extends Error {
  constructor(
    readonly circuit: string,
    readonly retryAfterMs: number,
    readonly lastError?: string
  ) {
    const seconds = Math.ceil(retryAfterMs / 1000);
    super(
      `${circuit} is not answering, so this request was refused without calling it ` +
        `(retrying in ~${seconds}s)${lastError ? `. Last error: ${lastError}` : ""}`
    );
    this.name = "CircuitOpenError";
  }
}

/**
 * Stops calling an upstream that has stopped answering.
 *
 * Retries make a single flaky call more likely to succeed and a genuinely
 * down forge much more expensive: every request pays the full retry
 * schedule and every attempt's timeout before failing, so a forge that is
 * hard-down turns a fast 502 into a request that occupies a connection for
 * half a minute. Enough of those in flight and the service stops answering
 * about the *other* two forges, which are fine - one outage becomes three.
 *
 * The breaker converts that into an immediate, cheap refusal that names
 * the reason, and spends one request per cooldown finding out whether the
 * upstream is back. Deliberately per-forge (see providers/), because
 * "GitHub is down" says nothing about GitLab, and a shared breaker would
 * let either of them take the others out.
 *
 * Per-process, like the rate limiter: each instance learns for itself that
 * an upstream is down, which costs a handful of requests per instance and
 * needs no shared state to go wrong.
 */
export class CircuitBreaker {
  private consecutiveFailures = 0;
  private openedAt: number | undefined;
  private lastError: string | undefined;
  /** True while the single half-open probe is in flight. */
  private probing = false;

  private readonly now: () => number;
  private readonly shouldTrip: (err: unknown) => boolean;

  constructor(
    readonly name: string,
    private readonly options: CircuitBreakerOptions
  ) {
    this.now = options.now ?? Date.now;
    this.shouldTrip = options.shouldTrip ?? (() => true);
  }

  state(): CircuitState {
    if (this.openedAt === undefined) return "closed";
    return this.now() - this.openedAt >= this.options.openMs ? "half-open" : "open";
  }

  /**
   * Runs `fn` unless the circuit says not to bother.
   *
   * While open, throws CircuitOpenError without calling `fn` at all. Once
   * the cooldown has elapsed, exactly one caller gets through as a probe
   * and the rest keep being refused until it settles - a recovering
   * upstream should meet one request, not the whole backlog that built up
   * while it was down.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const state = this.state();

    if (state === "open" || (state === "half-open" && this.probing)) {
      throw new CircuitOpenError(this.name, this.retryAfterMs(), this.lastError);
    }

    const isProbe = state === "half-open";
    if (isProbe) this.probing = true;

    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (err) {
      // An error the policy doesn't count is still an answer, and an
      // upstream that answers is up: a 404 closes a half-open circuit
      // rather than reopening it.
      if (this.shouldTrip(err)) this.recordFailure(err);
      else this.recordSuccess();
      throw err;
    } finally {
      if (isProbe) this.probing = false;
    }
  }

  private recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.openedAt = undefined;
    this.lastError = undefined;
  }

  private recordFailure(err: unknown): void {
    this.consecutiveFailures++;
    this.lastError = err instanceof Error ? err.message : String(err);
    // A failed probe reopens for a fresh cooldown rather than leaving the
    // circuit half-open, where every subsequent request would probe a
    // still-broken upstream.
    if (this.consecutiveFailures >= this.options.failureThreshold) {
      this.openedAt = this.now();
    }
  }

  private retryAfterMs(): number {
    if (this.openedAt === undefined) return 0;
    return Math.max(0, this.openedAt + this.options.openMs - this.now());
  }

  snapshot(): CircuitSnapshot {
    const state = this.state();
    return {
      name: this.name,
      state,
      consecutiveFailures: this.consecutiveFailures,
      ...(this.openedAt !== undefined
        ? { openedAt: new Date(this.openedAt).toISOString(), retryAfterMs: this.retryAfterMs() }
        : {}),
      ...(this.lastError !== undefined ? { lastError: this.lastError } : {})
    };
  }

  /** Back to a clean slate. For tests, and for an operator-triggered reset. */
  reset(): void {
    this.consecutiveFailures = 0;
    this.openedAt = undefined;
    this.lastError = undefined;
    this.probing = false;
  }
}
