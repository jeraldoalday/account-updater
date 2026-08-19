import { randomUUID } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      id: string;
    }
  }
}

/**
 * Reuses an incoming `x-request-id` (e.g. from a proxy or the caller) when
 * present, so a request can be traced across services; otherwise generates
 * one. Always echoed back on the response for the caller to log/report.
 */
export const requestId: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  req.id = req.header("x-request-id") || randomUUID();
  res.setHeader("x-request-id", req.id);
  next();
};
