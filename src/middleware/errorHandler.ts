import type { NextFunction, Request, Response } from "express";

interface BodyParserSyntaxError extends SyntaxError {
  status?: number;
  statusCode?: number;
  type?: string;
}

function isMalformedJsonError(err: unknown): err is BodyParserSyntaxError {
  return (
    err instanceof SyntaxError &&
    (err as BodyParserSyntaxError).type === "entity.parse.failed"
  );
}

// Must be registered last, and keep all four params so Express recognizes it
// as an error-handling middleware.
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (isMalformedJsonError(err)) {
    res.status(400).json({ error: "Request body must be valid JSON." });
    return;
  }

  console.error(`Unhandled error on ${req.method} ${req.originalUrl}:`, err);
  res.status(500).json({ error: "Internal server error." });
}
