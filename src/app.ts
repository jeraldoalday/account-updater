import express from "express";
import { eligibilityRouter } from "./routes/eligibility.route";
import { requestLogger } from "./middleware/requestLogger";
import { errorHandler } from "./middleware/errorHandler";
import { apiKeyAuth } from "./middleware/apiKeyAuth";
import { rateLimit } from "./middleware/rateLimit";
import { config } from "./config";
import { version } from "./version";

export function createApp() {
  const app = express();
  app.use(express.json());
  app.use(requestLogger);

  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok", version, uptimeSeconds: Math.round(process.uptime()) });
  });

  app.use(
    "/eligibility",
    rateLimit({ windowMs: config.rateLimitWindowMs, max: config.rateLimitMax }),
    apiKeyAuth(config.apiKey),
    eligibilityRouter
  );

  app.use(errorHandler);

  return app;
}
