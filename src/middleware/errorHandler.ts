import type { NextFunction, Request, Response } from "express";
import { MAX_ECHOED_PATH_LENGTH, truncate } from "../utils/truncate";

interface BodyParserSyntaxError extends SyntaxError {
  status?: number;
  statusCode?: number;
  type?: string;
}

function isMalformedJsonError(err: unknown): err is BodyParserSyntaxError {
  return (
    err instanceof SyntaxError && (err as BodyParserSyntaxError).type === "entity.parse.failed"
  );
}

// Must be registered last, and keep all four params so Express recognizes it
// as an error-handling middleware.
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (isMalformedJsonError(err)) {
    res.status(400).json({ error: "Request body must be valid JSON.", requestId: req.id });
    return;
  }

  console.error(
    JSON.stringify({
      level: "error",
      requestId: req.id,
      method: req.method,
      // Bounded, same as the access log and the 404 body: the path is
      // caller-chosen, and an unbounded echo of it makes filling a log
      // budget as cheap as sending long URLs - no less true on the error
      // path than on the happy one.
      path: truncate(req.originalUrl, MAX_ECHOED_PATH_LENGTH),
      message: err instanceof Error ? err.message : String(err),
      time: new Date().toISOString()
    })
  );
  res.status(500).json({ error: "Internal server error.", requestId: req.id });
}
