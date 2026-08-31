import { describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { rateLimit } from "../src/middleware/rateLimit";
import { eligibilityRequestCost } from "../src/routes/eligibility.route";
import type { Request } from "express";

vi.mock("../src/history/createHistoryStore", () => ({
  createHistoryStore: () => ({ record: vi.fn(), list: () => [] })
}));

/** A request as far as the cost function is concerned: just a body. */
function withBody(body: unknown): Request {
  return { body } as Request;
}

function appWithLimit(max: number) {
  const app = express();
  app.use(express.json());
  app.use(rateLimit({ windowMs: 60_000, max, cost: eligibilityRequestCost }));
  app.post("/check", (_req, res) => {
    res.status(200).json({ ok: true });
  });
  app.post("/check-batch", (_req, res) => {
    res.status(200).json({ ok: true });
  });
  return app;
}

describe("eligibilityRequestCost", () => {
  it("charges a single check one unit", () => {
    expect(eligibilityRequestCost(withBody({ repo: "acme/widgets" }))).toBe(1);
  });

  it("charges a batch once per repo, since each one is its own clone", () => {
    expect(eligibilityRequestCost(withBody({ repos: ["a/b", "c/d", "e/f"] }))).toBe(3);
  });

  // An over-long list is refused by the schema, so it causes no work at
  // all. Billing a caller a thousand units for a typo would cost them the
  // rest of the window for a request that did nothing.
  it("charges no more than the batch cap, whatever the caller sent", () => {
    const huge = Array.from({ length: 5_000 }, (_, i) => `acme/repo-${i}`);
    expect(eligibilityRequestCost(withBody({ repos: huge }))).toBe(20);
  });

  it("falls back to one unit for a body with no repo list", () => {
    expect(eligibilityRequestCost(withBody({}))).toBe(1);
    expect(eligibilityRequestCost(withBody(undefined))).toBe(1);
  });

  it("falls back to one unit when repos is not a list at all", () => {
    expect(eligibilityRequestCost(withBody({ repos: "acme/widgets" }))).toBe(1);
    expect(eligibilityRequestCost(withBody({ repos: 40 }))).toBe(1);
  });
});

describe("rate limiting priced per repo", () => {
  // The gap this closes: with the default budget of 20 requests a minute,
  // a caller sending batches of 20 instead of single checks got 400 clones
  // a minute out of an allowance that says 20.
  it("spends a batch's whole cost, not one unit for the request", async () => {
    const app = appWithLimit(10);

    const res = await request(app)
      .post("/check-batch")
      .send({ repos: ["a/b", "c/d", "e/f", "g/h"] });

    expect(res.status).toBe(200);
    expect(res.headers["x-ratelimit-remaining"]).toBe("6");
  });

  it("refuses the batch that would take a caller past the limit", async () => {
    const app = appWithLimit(5);

    const first = await request(app)
      .post("/check-batch")
      .send({ repos: ["a/b", "c/d", "e/f"] });
    const second = await request(app)
      .post("/check-batch")
      .send({ repos: ["g/h", "i/j", "k/l"] });

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(second.headers["retry-after"]).toBeDefined();
  });

  it("leaves a single check costing one unit, as it always did", async () => {
    const app = appWithLimit(3);

    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await request(app).post("/check").send({ repo: "acme/widgets" });
      statuses.push(res.status);
    }

    expect(statuses).toEqual([200, 200, 200, 429]);
  });

  it("reports remaining budget in repos, so a caller can size its next batch", async () => {
    const app = appWithLimit(20);

    const res = await request(app)
      .post("/check-batch")
      .send({ repos: ["a/b", "c/d", "e/f", "g/h", "i/j"] });

    expect(res.headers["x-ratelimit-limit"]).toBe("20");
    expect(res.headers["x-ratelimit-remaining"]).toBe("15");
  });

  // The cost function reads a body the caller controls. A cost that came
  // back NaN would make every comparison against the window false and
  // switch the limiter off for that key - a limiter defeated by sending
  // it nonsense is worse than no limiter, because it looks like one.
  it("does not let a hostile cost function disable the limit", async () => {
    const app = express();
    app.use(express.json());
    app.use(rateLimit({ windowMs: 60_000, max: 2, cost: () => Number.NaN }));
    app.post("/check", (_req, res) => {
      res.status(200).json({ ok: true });
    });

    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      statuses.push((await request(app).post("/check").send({})).status);
    }

    expect(statuses).toEqual([200, 200, 429]);
  });

  it("treats a cost below one unit as one, so nothing is free", async () => {
    const app = express();
    app.use(express.json());
    app.use(rateLimit({ windowMs: 60_000, max: 2, cost: () => 0 }));
    app.post("/check", (_req, res) => {
      res.status(200).json({ ok: true });
    });

    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      statuses.push((await request(app).post("/check").send({})).status);
    }

    expect(statuses).toEqual([200, 200, 429]);
  });
});

describe("POST /eligibility/check-batch against the real app", () => {
  it("bills the configured budget per repo the caller listed", async () => {
    const { createApp } = await import("../src/app");

    const res = await request(createApp())
      .post("/eligibility/check-batch")
      .send({ repos: ["not a valid ref", "also not valid"] });

    expect(res.status).toBe(200);
    const limit = Number(res.headers["x-ratelimit-limit"]);
    expect(Number(res.headers["x-ratelimit-remaining"])).toBe(limit - 2);
  });
});
