import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { rateLimit, sweepExpiredWindows } from "../src/middleware/rateLimit";

function appWith(windowMs: number, max: number, sweepEveryNRequests?: number) {
  const app = express();
  app.use(rateLimit({ windowMs, max, sweepEveryNRequests }));
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

  it("keeps enforcing the limit correctly across an opportunistic sweep", async () => {
    // sweepEveryNRequests=3 means the 3rd request triggers a sweep of
    // expired windows mid-stream; the still-active key's own window must
    // survive that sweep untouched.
    const app = appWith(60_000, 2, 3);
    const key = "sweep-test-key";

    const first = await request(app).get("/ping").set("x-api-key", key);
    const second = await request(app).get("/ping").set("x-api-key", key);
    const third = await request(app).get("/ping").set("x-api-key", key);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(429);
  });
});

describe("sweepExpiredWindows", () => {
  it("removes only the windows whose reset time has already passed", () => {
    const windows = new Map([
      ["expired", { count: 5, resetAt: 100 }],
      ["active", { count: 2, resetAt: 500 }]
    ]);

    sweepExpiredWindows(windows, 200);

    expect(windows.has("expired")).toBe(false);
    expect(windows.has("active")).toBe(true);
    expect(windows.size).toBe(1);
  });

  it("does nothing when no windows have expired yet", () => {
    const windows = new Map([["active", { count: 1, resetAt: 1000 }]]);

    sweepExpiredWindows(windows, 500);

    expect(windows.size).toBe(1);
  });

  it("treats a window expiring at exactly `now` as expired", () => {
    const windows = new Map([["boundary", { count: 1, resetAt: 1000 }]]);

    sweepExpiredWindows(windows, 1000);

    expect(windows.size).toBe(0);
  });
});
