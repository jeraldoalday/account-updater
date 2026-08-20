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

function appWithTrustedKey(windowMs: number, max: number, trustedApiKey: string) {
  const app = express();
  app.use(rateLimit({ windowMs, max, trustedApiKey }));
  app.get("/ping", (_req, res) => res.status(200).json({ ok: true }));
  return app;
}

describe("rateLimit bucket selection", () => {
  it("does not let an unrecognized x-api-key mint a fresh bucket per request", async () => {
    // The bypass this exists to prevent: rotate the header and every
    // request looks like the first one in a new window. It ran before
    // apiKeyAuth, so no valid credential was needed to do it.
    const app = appWithTrustedKey(60_000, 2, "real-key");

    expect((await request(app).get("/ping").set("x-api-key", "guess-1")).status).toBe(200);
    expect((await request(app).get("/ping").set("x-api-key", "guess-2")).status).toBe(200);
    expect((await request(app).get("/ping").set("x-api-key", "guess-3")).status).toBe(429);
  });

  it("ignores the header entirely when no API key is configured", async () => {
    // With auth disabled the header is just caller-supplied text, so it
    // must not influence bucketing at all.
    const app = appWith(60_000, 2);

    expect((await request(app).get("/ping").set("x-api-key", "a")).status).toBe(200);
    expect((await request(app).get("/ping").set("x-api-key", "b")).status).toBe(200);
    expect((await request(app).get("/ping").set("x-api-key", "c")).status).toBe(429);
  });

  it("gives a caller presenting the configured key its own budget", async () => {
    // The legitimate case the per-key bucket exists for: a keyed caller
    // isn't throttled by unrelated traffic from the same address.
    const app = appWithTrustedKey(60_000, 2, "real-key");

    await request(app).get("/ping");
    await request(app).get("/ping");
    expect((await request(app).get("/ping")).status).toBe(429);

    expect((await request(app).get("/ping").set("x-api-key", "real-key")).status).toBe(200);
  });

  it("counts requests with a wrong key against the caller's address, not their guess", async () => {
    const app = appWithTrustedKey(60_000, 2, "real-key");

    await request(app).get("/ping").set("x-api-key", "wrong");
    await request(app).get("/ping");
    expect((await request(app).get("/ping").set("x-api-key", "also-wrong")).status).toBe(429);
  });
});

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

  it("keeps the keyed caller's budget separate from anonymous traffic", async () => {
    // Previously this asserted that *any* two x-api-key values got
    // separate budgets, which is what made the limiter bypassable. The
    // real requirement is narrower: a caller presenting the configured key
    // has one budget, and exhausting it doesn't consume anyone else's.
    const app = appWithTrustedKey(60_000, 1, "real-key");

    expect((await request(app).get("/ping").set("x-api-key", "real-key")).status).toBe(200);
    expect((await request(app).get("/ping").set("x-api-key", "real-key")).status).toBe(429);
    expect((await request(app).get("/ping")).status).toBe(200);
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
  it("reports the budget on a successful response, not only on a refusal", async () => {
    // A caller can only pace itself if it can see the remaining budget
    // before it runs out.
    const app = appWith(60_000, 5);

    const res = await request(app).get("/ping");

    expect(res.status).toBe(200);
    expect(res.headers["x-ratelimit-limit"]).toBe("5");
    expect(res.headers["x-ratelimit-remaining"]).toBe("4");
    expect(Number(res.headers["x-ratelimit-reset"])).toBeGreaterThan(Date.now() / 1000);
  });

  it("counts the remaining budget down across requests", async () => {
    const app = appWith(60_000, 3);

    const first = await request(app).get("/ping");
    const second = await request(app).get("/ping");

    expect(first.headers["x-ratelimit-remaining"]).toBe("2");
    expect(second.headers["x-ratelimit-remaining"]).toBe("1");
  });

  it("never reports a negative remaining budget once over the limit", async () => {
    const app = appWith(60_000, 1);

    await request(app).get("/ping");
    await request(app).get("/ping");
    const third = await request(app).get("/ping");

    expect(third.status).toBe(429);
    expect(third.headers["x-ratelimit-remaining"]).toBe("0");
    expect(third.headers["retry-after"]).toBeDefined();
  });
});
