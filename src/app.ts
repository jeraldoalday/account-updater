import express from "express";
import { eligibilityRouter } from "./routes/eligibility.route";
import { requestLogger } from "./middleware/requestLogger";
import { errorHandler } from "./middleware/errorHandler";
import { apiKeyAuth } from "./middleware/apiKeyAuth";
import { config } from "./config";

export function createApp() {
  const app = express();
  app.use(express.json());
  app.use(requestLogger);

  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.use("/eligibility", apiKeyAuth(config.apiKey), eligibilityRouter);

  app.use(errorHandler);

  return app;
}
