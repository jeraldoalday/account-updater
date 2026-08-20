import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const ping = vi.fn();
const historyPing = vi.fn();

vi.mock("../src/cache/createCache", () => ({
  createCache: () => ({ get: vi.fn(), set: vi.fn(), clear: vi.fn(), ping }),
  closeCache: vi.fn()
}));

vi.mock("../src/history/createHistoryStore", () => ({
  createHistoryStore: () => ({
    ping: historyPing,
    record: vi.fn(),
    list: () => []
  })
}));

const { checkReadiness } = await import("../src/health/readiness");
const { createApp } = await import("../src/app");
const { beginDraining, resetDrainState } = await import("../src/lifecycle/drainState");

describe("checkReadiness", () => {
  beforeEach(() => {
    ping.mockReset().mockResolvedValue(undefined);
    historyPing.mockReset().mockReturnValue(undefined);
  });

  it("reports ready when both dependencies answer", async () => {
    await expect(checkReadiness()).resolves.toEqual({
      ready: true,
      draining: false,
      checks: { cache: { ok: true }, history: { ok: true } }
    });
  });

  it("reports the cache as unusable, with the reason, when it can't be reached", async () => {
    ping.mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:6379"));

    const report = await checkReadiness();
    expect(report.ready).toBe(false);
    expect(report.checks.cache).toEqual({
      ok: false,
      error: "connect ECONNREFUSED 127.0.0.1:6379"
    });
    // One dependency failing must not hide the other's status.
    expect(report.checks.history.ok).toBe(true);
  });

  it("reports the audit trail as unusable when the database can't be queried", async () => {
    historyPing.mockImplementation(() => {
      throw new Error("no such table: evaluations");
    });

    const report = await checkReadiness();
    expect(report.ready).toBe(false);
    expect(report.checks.history).toEqual({ ok: false, error: "no such table: evaluations" });
  });

  it("checks the audit trail even when the cache is already down", async () => {
    // A short-circuit here would make one outage mask another, which is
    // exactly the thing this endpoint exists to prevent.
    ping.mockRejectedValue(new Error("down"));
    historyPing.mockImplementation(() => {
      throw new Error("also down");
    });

    const report = await checkReadiness();
    expect(report.checks.cache.ok).toBe(false);
    expect(report.checks.history.ok).toBe(false);
  });
});

describe("GET /ready", () => {
  beforeEach(() => {
    ping.mockReset().mockResolvedValue(undefined);
    historyPing.mockReset().mockReturnValue(undefined);
  });

  it("answers 200 when dependencies are usable", async () => {
    const res = await request(createApp()).get("/ready");

    expect(res.status).toBe(200);
    expect(res.body.ready).toBe(true);
  });

  it("answers 503, not 200, when a dependency is unusable", async () => {
    ping.mockRejectedValue(new Error("redis is gone"));

    const res = await request(createApp()).get("/ready");

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      ready: false,
      draining: false,
      checks: { cache: { ok: false, error: "redis is gone" }, history: { ok: true } }
    });
  });

  it("needs no API key, so a load balancer can probe it", async () => {
    // Same reasoning as /health: the probe runs before any credential is
    // configured on the caller.
    const res = await request(createApp()).get("/ready");
    expect(res.status).not.toBe(401);
  });
});

describe("readiness while shutting down", () => {
  beforeEach(() => {
    ping.mockReset().mockResolvedValue(undefined);
    historyPing.mockReset().mockReturnValue(undefined);
    resetDrainState();
  });

  afterEach(() => resetDrainState());

  it("answers 503 as soon as shutdown starts, while dependencies are still fine", async () => {
    // This is what takes the instance out of the load balancer's rotation
    // *before* the listener closes. Reporting 200 here until the socket
    // shuts is what turns a rolling deploy into dropped connections.
    beginDraining();

    const res = await request(createApp()).get("/ready");

    expect(res.status).toBe(503);
    expect(res.body.ready).toBe(false);
    expect(res.body.draining).toBe(true);
    expect(res.body.checks.cache.ok).toBe(true);
  });

  it("keeps /health at 200 while draining, so the platform doesn't restart it", async () => {
    beginDraining();

    const res = await request(createApp()).get("/health");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("draining");
  });
});
