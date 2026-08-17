import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestId } from "../src/middleware/requestId";
import { requestLogger } from "../src/middleware/requestLogger";
import { metrics } from "../src/metrics/metrics";

function testApp() {
  const app = express();
  app.use(requestId);
  app.use(requestLogger);
  app.get("/ok", (_req, res) => res.status(200).json({ ok: true }));
  app.get("/missing", (_req, res) => res.status(404).json({ error: "not found" }));
  return app;
}

describe("requestLogger", () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    metrics.reset();
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
  });

  it("logs one structured JSON line per request with method/path/status/duration", async () => {
    await request(testApp()).get("/ok");

    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
    expect(logged.level).toBe("info");
    expect(logged.method).toBe("GET");
    expect(logged.path).toBe("/ok");
    expect(logged.status).toBe(200);
    expect(typeof logged.durationMs).toBe("number");
    expect(typeof logged.requestId).toBe("string");
    expect(typeof logged.time).toBe("string");
  });

  it("logs the real response status, not just 200s", async () => {
    await request(testApp()).get("/missing");

    const logged = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
    expect(logged.status).toBe(404);
  });

  it("uses the same request ID that was assigned to the request", async () => {
    const res = await request(testApp()).get("/ok").set("x-request-id", "fixed-id-123");

    expect(res.headers["x-request-id"]).toBe("fixed-id-123");
    const logged = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
    expect(logged.requestId).toBe("fixed-id-123");
  });

  it("records the request in metrics, bucketed by status class", async () => {
    await request(testApp()).get("/ok");
    await request(testApp()).get("/missing");

    const snapshot = metrics.snapshot();
    expect(snapshot.requestsTotal).toBe(2);
    expect(snapshot.requestsByStatusClass).toEqual({ "2xx": 1, "4xx": 1 });
  });
});
