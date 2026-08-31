import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { CircuitOpenError } from "../src/net/circuitBreaker";

const getCommitHistorySummary = vi.fn();
const getPushEventSummary = vi.fn();

vi.mock("../src/providers/registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/providers/registry")>()),
  createProvider: () => ({ id: "github", getCommitHistorySummary, getPushEventSummary })
}));

vi.mock("../src/clone/tempClone", () => ({
  withShallowClone: async (_r: unknown, _t: unknown, fn: (d: string) => unknown) => fn("/fake/dir")
}));

vi.mock("../src/analysis/sourceScan", () => ({
  scanSource: async () => ({
    byLanguage: [{ language: "TypeScript", lines: 9000, files: 60 }],
    totalLines: 9000,
    totalFiles: 60,
    primaryLanguage: "TypeScript",
    skippedLargeFiles: 0
  })
}));

vi.mock("../src/history/createHistoryStore", () => ({
  createHistoryStore: () => ({ record: vi.fn(), list: () => [] })
}));

vi.mock("../src/cache/createCache", () => ({
  createCache: () => ({ get: async () => undefined, set: async () => undefined, clear: vi.fn() })
}));

const { createApp } = await import("../src/app");

describe("a check against a forge whose circuit is open", () => {
  beforeEach(() => {
    getCommitHistorySummary
      .mockReset()
      .mockRejectedValue(new CircuitOpenError("GitHub", 27_000, "503 from api.github.com"));
    getPushEventSummary.mockReset().mockResolvedValue({
      available: false,
      distinctPushDays: 0,
      maxSinglePushCommitShare: 0
    });
  });

  // 503, not the 502 an unclassified upstream error gets: this is "come
  // back later", not "something broke while we tried".
  it("answers 503 rather than a generic upstream failure", async () => {
    const res = await request(createApp())
      .post("/eligibility/check")
      .send({ repo: "acme/widgets" });

    expect(res.status).toBe(503);
  });

  // The breaker is counting down its own cooldown, so it knows exactly
  // when a retry is worth making. "Try again later" is the one instruction
  // an integration can't act on.
  it("says how long to wait, in a header a client can act on", async () => {
    const res = await request(createApp())
      .post("/eligibility/check")
      .send({ repo: "acme/widgets" });

    expect(res.headers["retry-after"]).toBe("27");
  });

  it("names the forge and the repo that was being checked", async () => {
    const res = await request(createApp())
      .post("/eligibility/check")
      .send({ repo: "acme/widgets" });

    expect(res.body.error).toContain("GitHub");
    expect(res.body.error).toContain("github.com/acme/widgets");
  });

  // The wait is real but the quota is untouched, and reporting it under a
  // rateLimit key would send a caller to check a budget that has plenty
  // left - the same mistake the 503 message used to make about which
  // forge had refused.
  it("does not dress the wait up as a rate limit", async () => {
    const res = await request(createApp())
      .post("/eligibility/check")
      .send({ repo: "acme/widgets" });

    expect(res.body.rateLimit).toBeUndefined();
  });

  it("reports the wait per entry in a batch", async () => {
    const res = await request(createApp())
      .post("/eligibility/check-batch")
      .send({ repos: ["acme/widgets"] });

    expect(res.status).toBe(200);
    expect(res.body.results[0]).toMatchObject({
      repo: "github.com/acme/widgets",
      retryAfterSeconds: 27
    });
  });
});
