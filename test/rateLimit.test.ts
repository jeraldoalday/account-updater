import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { rateLimit } from "../src/middleware/rateLimit";

function appWith(windowMs: number, max: number) {
  const app = express();
  app.use(rateLimit({ windowMs, max }));
  app.get("/ping", (_req, res) => res.status(200).json({ ok: true }));
  return app;
}

describe("rateLimit", () => {
  it("allows requests under the limit", async () => {
    const app = appWith(60_000, 3);
    for (let i = 0; i < 3; i++) {
      const res = await request(app).get("/ping");
      expect(res.status).toBe(200);
    }
  });

  it("rejects requests once the limit is exceeded within the window", async () => {
    const app = appWith(60_000, 2);
    await request(app).get("/ping");
    await request(app).get("/ping");
    const res = await request(app).get("/ping");
    expect(res.status).toBe(429);
    expect(res.body.error).toMatch(/too many requests/i);
    expect(res.headers["retry-after"]).toBeDefined();
  });

  it("tracks separate callers independently by x-api-key", async () => {
    const app = appWith(60_000, 1);
    const first = await request(app).get("/ping").set("x-api-key", "caller-a");
    const second = await request(app).get("/ping").set("x-api-key", "caller-b");
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const blocked = await request(app).get("/ping").set("x-api-key", "caller-a");
    expect(blocked.status).toBe(429);
  });

  it("resets the count after the window elapses", async () => {
    const app = appWith(50, 1);
    const first = await request(app).get("/ping");
    expect(first.status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 60));

    const afterReset = await request(app).get("/ping");
    expect(afterReset.status).toBe(200);
  });
});
