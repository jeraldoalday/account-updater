import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Requires a matching `x-api-key` header when `expectedKey` is set. With no
 * key configured, auth is a no-op (useful for local development).
 */
export function apiKeyAuth(expectedKey: string | undefined): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!expectedKey) {
      next();
      return;
    }

    const provided = req.header("x-api-key");
    if (!provided || !safeEqual(provided, expectedKey)) {
      res.status(401).json({ error: "Missing or invalid API key." });
      return;
    }

    next();
  };
}
