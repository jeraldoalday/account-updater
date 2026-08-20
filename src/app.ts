import express from "express";
import { eligibilityRouter } from "./routes/eligibility.route";
import { adminRouter } from "./routes/admin.route";
import { requestId } from "./middleware/requestId";
import { requestLogger } from "./middleware/requestLogger";
import { errorHandler } from "./middleware/errorHandler";
import { notFound } from "./middleware/notFound";
import { apiKeyAuth } from "./middleware/apiKeyAuth";
import { rateLimit } from "./middleware/rateLimit";
import { config } from "./config";
import { version } from "./version";
import { metrics } from "./metrics/metrics";
import { toPrometheusText } from "./metrics/prometheusFormat";
import { openApiSpec } from "./openapi";
import { checkReadiness } from "./health/readiness";
import { isDraining } from "./lifecycle/drainState";

export function createApp() {
  const app = express();
  // Must run before express.json() so a malformed-JSON error (caught by
  // errorHandler) still has a request ID to report.
  app.use(requestId);
  app.use(express.json());
  app.use(requestLogger);

  // Stays 200 even while draining: this answers "restart me?", and a
  // process that is deliberately shutting down must not be restarted for
  // it. The status string still says which of the two it is, so a human
  // reading a probe response isn't misled by the 200.
  app.get("/health", (_req, res) => {
    res.status(200).json({
      status: isDraining() ? "draining" : "ok",
      version,
      uptimeSeconds: Math.round(process.uptime())
    });
  });

  // Liveness (above) answers "restart me?"; readiness answers "send me
  // traffic?" - the dependencies below can be down while the process is
  // perfectly alive, and both failures are non-fatal per request by
  // design, so nothing else would surface them.
  app.get("/ready", async (_req, res, next) => {
    try {
      const report = await checkReadiness();
      res.status(report.ready ? 200 : 503).json(report);
    } catch (err) {
      next(err);
    }
  });

  app.get("/metrics", (_req, res) => {
    res.status(200).json(metrics.snapshot());
  });

  app.get("/metrics/prometheus", (_req, res) => {
    res
      .status(200)
      .set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
      .send(toPrometheusText(metrics.snapshot()));
  });

  app.get("/openapi.json", (_req, res) => {
    res.status(200).json(openApiSpec);
  });

  app.use(
    "/eligibility",
    rateLimit({
      windowMs: config.rateLimitWindowMs,
      max: config.rateLimitMax,
      trustedApiKey: config.apiKey
    }),
    apiKeyAuth(config.apiKey),
    eligibilityRouter
  );

  // Its own budget rather than a share of /eligibility's: an admin read is
  // cheap next to a clone, so hammering it shouldn't spend the expensive
  // endpoint's allowance - but it is still a database scan behind an API
  // key that is optional, so it can't be unlimited either.
  app.use(
    "/admin",
    rateLimit({
      windowMs: config.rateLimitWindowMs,
      max: config.rateLimitMax,
      trustedApiKey: config.apiKey
    }),
    apiKeyAuth(config.apiKey),
    adminRouter
  );

  // After every route, before the error handler: anything that reached
  // here matched nothing.
  app.use(notFound);
  app.use(errorHandler);

  return app;
}
