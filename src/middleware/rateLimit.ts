import type { NextFunction, Request, RequestHandler, Response } from "express";

interface Window {
  count: number;
  resetAt: number;
}

export interface RateLimitOptions {
  windowMs: number;
  max: number;
}

/**
 * Fixed-window in-memory rate limiter. Keyed by the caller's API key when
 * present (so a single caller with a shared key gets one budget across
 * instances behind the same proxy header setup), falling back to remote IP.
 * Not distributed — fine for a single-instance deployment, but a multi-node
 * deployment would need a shared store to enforce one global limit.
 */
export function rateLimit(options: RateLimitOptions): RequestHandler {
  const windows = new Map<string, Window>();

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = req.header("x-api-key") ?? req.ip ?? "unknown";
    const now = Date.now();

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
