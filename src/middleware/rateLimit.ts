import type { NextFunction, Request, RequestHandler, Response } from "express";

interface Window {
  count: number;
  resetAt: number;
}

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  /**
   * The API key the service is configured to accept, if any. Only a header
   * matching this value is allowed to select a bucket; see keyFor().
   */
  trustedApiKey?: string;
  // How many requests to handle between opportunistic sweeps of expired
  // windows. Every distinct key (API key or IP) gets its own entry that
  // otherwise only gets touched again if that same key makes another
  // request, so without a sweep a public-facing instance's window map
  // grows forever as new IPs show up. Configurable mainly so tests don't
  // need thousands of requests to exercise it.
  sweepEveryNRequests?: number;
}

const DEFAULT_SWEEP_EVERY_N_REQUESTS = 1000;

/** Removes windows whose reset time has already passed. Exported for direct unit testing. */
export function sweepExpiredWindows(windows: Map<string, Window>, now: number): void {
  for (const [key, window] of windows) {
    if (now >= window.resetAt) windows.delete(key);
  }
}

/**
 * Chooses the bucket a request counts against.
 *
 * Only an `x-api-key` header that *matches the configured key* selects a
 * per-key bucket. Keying on the raw header instead - which this used to do
 * - hands every caller an unlimited supply of buckets: send a different
 * random value each time and every request is the first in a fresh window.
 * That defeats the limiter entirely, and it does so before apiKeyAuth ever
 * runs, so it applies to unauthenticated callers and to deployments with
 * no API_KEY configured at all.
 *
 * Buckets are namespaced by kind so an IP can never collide with a key.
 */
function keyFor(req: Request, trustedApiKey: string | undefined): string {
  const provided = req.header("x-api-key");
  if (trustedApiKey && provided === trustedApiKey) return `key:${provided}`;
  return `ip:${req.ip ?? "unknown"}`;
}

/**
 * Fixed-window in-memory rate limiter. Keyed by the caller's API key when
 * they present the configured one (so a single caller with a shared key
 * gets one budget across instances behind the same proxy header setup),
 * falling back to remote IP. Not distributed — fine for a single-instance
 * deployment, but a multi-node deployment would need a shared store to
 * enforce one global limit.
 *
 * Runs before apiKeyAuth deliberately: a flood of requests with no key, or
 * a wrong one, should be limited too, not merely rejected one 401 at a
 * time.
 */
export function rateLimit(options: RateLimitOptions): RequestHandler {
  const windows = new Map<string, Window>();
  const sweepEveryNRequests = options.sweepEveryNRequests ?? DEFAULT_SWEEP_EVERY_N_REQUESTS;
  let requestsSinceSweep = 0;

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = keyFor(req, options.trustedApiKey);
    const now = Date.now();

    requestsSinceSweep++;
    if (requestsSinceSweep >= sweepEveryNRequests) {
      requestsSinceSweep = 0;
      sweepExpiredWindows(windows, now);
    }

    let window = windows.get(key);
    if (!window || now >= window.resetAt) {
      window = { count: 0, resetAt: now + options.windowMs };
      windows.set(key, window);
    }

    window.count++;

    if (window.count > options.max) {
      const retryAfterSeconds = Math.ceil((window.resetAt - now) / 1000);
      res.setHeader("Retry-After", String(retryAfterSeconds));
      res.status(429).json({ error: "Too many requests. Please slow down and try again later." });
      return;
    }

    next();
  };
}
