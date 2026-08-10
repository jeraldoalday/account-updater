import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const evaluateEligibility = vi.fn();

vi.mock("../src/eligibility/evaluate", () => ({
  evaluateEligibility: (...args: unknown[]) => evaluateEligibility(...args)
}));

// Imported after the mock so the route picks up the mocked module.
const { createApp } = await import("../src/app");

describe("app", () => {
  beforeEach(() => {
    evaluateEligibility.mockReset();
  });

  it("GET /health returns ok with version and uptime", async () => {
    const res = await request(createApp()).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(typeof res.body.version).toBe("string");
    expect(typeof res.body.uptimeSeconds).toBe("number");
  });

  it("GET /metrics returns counters", async () => {
    const res = await request(createApp()).get("/metrics");
    expect(res.status).toBe(200);
    expect(typeof res.body.requestsTotal).toBe("number");
    expect(typeof res.body.eligibilityChecksTotal).toBe("number");
  });

  it("POST /eligibility/check rejects a missing repo", async () => {
    const res = await request(createApp()).post("/eligibility/check").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/repo is required/);
    expect(evaluateEligibility).not.toHaveBeenCalled();
  });

  it("POST /eligibility/check rejects an unparseable repo reference", async () => {
    const res = await request(createApp()).post("/eligibility/check").send({ repo: "not a repo" });
    expect(res.status).toBe(400);
    expect(evaluateEligibility).not.toHaveBeenCalled();
  });

  it("POST /eligibility/check returns the evaluator's result on success", async () => {
    const fakeResult = { eligible: true, repo: { owner: "o", repo: "r" }, checks: {}, reasons: [] };
    evaluateEligibility.mockResolvedValue(fakeResult);

    const res = await request(createApp()).post("/eligibility/check").send({ repo: "o/r" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(fakeResult);
    expect(evaluateEligibility).toHaveBeenCalledWith(
      { owner: "o", repo: "r" },
      undefined,
      { cacheable: true }
    );
  });

  it("marks a request with its own token as non-cacheable", async () => {
    evaluateEligibility.mockResolvedValue({ eligible: false, repo: {}, checks: {}, reasons: [] });

    await request(createApp())
      .post("/eligibility/check")
      .send({ repo: "o/r", token: "caller-token" });

    expect(evaluateEligibility).toHaveBeenCalledWith(
      { owner: "o", repo: "r" },
      "caller-token",
      { cacheable: false }
    );
  });

  it("POST /eligibility/check returns 502 when evaluation fails", async () => {
    evaluateEligibility.mockRejectedValue(new Error("boom"));

    const res = await request(createApp()).post("/eligibility/check").send({ repo: "o/r" });

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/boom/);
  });

  it("POST /eligibility/check returns 503 with rate-limit info when GitHub rate-limits the request", async () => {
    evaluateEligibility.mockRejectedValue(
      Object.assign(new Error("rate limited"), {
        status: 403,
        response: { headers: { "retry-after": "42" } }
      })
    );

    const res = await request(createApp()).post("/eligibility/check").send({ repo: "o/r" });

    expect(res.status).toBe(503);
    expect(res.body.rateLimit.retryAfterSeconds).toBe(42);
    expect(res.headers["retry-after"]).toBe("42");
  });

  it("rejects a malformed JSON body", async () => {
    const res = await request(createApp())
      .post("/eligibility/check")
      .set("Content-Type", "application/json")
      .send("{not json");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/valid JSON/);
    expect(res.body.requestId).toBeTruthy();
    expect(res.headers["x-request-id"]).toBe(res.body.requestId);
  });

  describe("POST /eligibility/check-batch", () => {
    it("rejects an empty repos array", async () => {
      const res = await request(createApp()).post("/eligibility/check-batch").send({ repos: [] });
      expect(res.status).toBe(400);
      expect(evaluateEligibility).not.toHaveBeenCalled();
    });

    it("rejects a batch larger than the max size", async () => {
      const repos = Array.from({ length: 21 }, (_, i) => `owner/repo-${i}`);
      const res = await request(createApp()).post("/eligibility/check-batch").send({ repos });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/cannot contain more than 20/);
    });

    it("evaluates each repo and returns results in the same order as the request", async () => {
      evaluateEligibility.mockImplementation(async (ref: { owner: string; repo: string }) => ({
        eligible: ref.repo === "good",
        repo: ref,
        checks: {},
        reasons: []
      }));

      const res = await request(createApp())
        .post("/eligibility/check-batch")
        .send({ repos: ["o/good", "o/bad"] });

      expect(res.status).toBe(200);
      expect(res.body.results).toHaveLength(2);
      expect(res.body.results[0].eligible).toBe(true);
      expect(res.body.results[1].eligible).toBe(false);
    });

    it("isolates a per-repo failure without failing the whole batch", async () => {
      evaluateEligibility.mockImplementation(async (ref: { owner: string; repo: string }) => {
        if (ref.repo === "broken") throw new Error("clone failed");
        return { eligible: true, repo: ref, checks: {}, reasons: [] };
      });

      const res = await request(createApp())
        .post("/eligibility/check-batch")
        .send({ repos: ["o/good", "o/broken"] });

      expect(res.status).toBe(200);
      expect(res.body.results[0].eligible).toBe(true);
      expect(res.body.results[1].error).toMatch(/clone failed/);
    });

    it("reports an unparseable repo entry without aborting the rest of the batch", async () => {
      evaluateEligibility.mockResolvedValue({ eligible: true, repo: {}, checks: {}, reasons: [] });

      const res = await request(createApp())
        .post("/eligibility/check-batch")
        .send({ repos: ["not a repo", "o/good"] });

      expect(res.status).toBe(200);
      expect(res.body.results[0].error).toBeTruthy();
      expect(res.body.results[1].eligible).toBe(true);
    });
  });
});
