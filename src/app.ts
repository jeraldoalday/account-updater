import express from "express";
import { eligibilityRouter } from "./routes/eligibility.route";
import { adminRouter } from "./routes/admin.route";
import { requestId } from "./middleware/requestId";
import { requestLogger } from "./middleware/requestLogger";
import { errorHandler } from "./middleware/errorHandler";
import { apiKeyAuth } from "./middleware/apiKeyAuth";
import { rateLimit } from "./middleware/rateLimit";
import { config } from "./config";
import { version } from "./version";
import { metrics } from "./metrics/metrics";
import { toPrometheusText } from "./metrics/prometheusFormat";
import { openApiSpec } from "./openapi";

export function createApp() {
  const app = express();
  // Must run before express.json() so a malformed-JSON error (caught by
  // errorHandler) still has a request ID to report.
  app.use(requestId);
  app.use(express.json());
  app.use(requestLogger);

  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok", version, uptimeSeconds: Math.round(process.uptime()) });
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
    rateLimit({ windowMs: config.rateLimitWindowMs, max: config.rateLimitMax }),
    apiKeyAuth(config.apiKey),
    eligibilityRouter
  );

  app.use("/admin", apiKeyAuth(config.apiKey), adminRouter);

  app.use(errorHandler);

  return app;
}
