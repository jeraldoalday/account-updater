import express from "express";
import { eligibilityRouter } from "./routes/eligibility.route";

export function createApp() {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.use("/eligibility", eligibilityRouter);

  return app;
}
