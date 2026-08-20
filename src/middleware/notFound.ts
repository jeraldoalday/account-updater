import type { Request, Response } from "express";
import { MAX_ECHOED_PATH_LENGTH, truncate } from "../utils/truncate";

/**
 * Answers unmatched routes in the same JSON shape as every other error.
 *
 * Without this, Express's default handler takes over and replies with an
 * HTML error page - so a typo'd path is the one response in the whole API
 * that a client parsing `error` out of a JSON body can't read, and it
 * arrives as a content-type they didn't ask for. Registered after the
 * routes and before errorHandler.
 */
export function notFound(req: Request, res: Response): void {
  const path = truncate(req.path, MAX_ECHOED_PATH_LENGTH);

  res.status(404).json({
    error: `No route for ${req.method} ${path}. See GET /openapi.json for the routes this service serves.`,
    requestId: req.id
  });
}
