import type { NextFunction, Request, Response } from "express";

// Structured (one JSON object per line) so logs are machine-parseable by a
// log aggregator, with the request ID as the join key across a request's
// access log line and any error log line it produces.
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = process.hrtime.bigint();
  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
    console.log(
      JSON.stringify({
        level: "info",
        requestId: req.id,
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        durationMs: Number(durationMs.toFixed(1)),
        time: new Date().toISOString()
      })
    );
  });
  next();
}
