import type { NextFunction, Request, Response } from "express";
import { metrics } from "../metrics/metrics";
import { MAX_ECHOED_PATH_LENGTH, truncate } from "../utils/truncate";

// Structured (one JSON object per line) so logs are machine-parseable by a
// log aggregator, with the request ID as the join key across a request's
// access log line and any error log line it produces.
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = process.hrtime.bigint();
  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
    metrics.recordRequest(res.statusCode);
    console.log(
      JSON.stringify({
        level: "info",
        requestId: req.id,
        method: req.method,
        // Bounded: the path is caller-chosen, and an unbounded echo of it
        // makes filling a log budget as cheap as sending long URLs.
        path: truncate(req.originalUrl, MAX_ECHOED_PATH_LENGTH),
        status: res.statusCode,
        durationMs: Number(durationMs.toFixed(1)),
        time: new Date().toISOString()
      })
    );
  });
  next();
}
