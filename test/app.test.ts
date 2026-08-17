import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const evaluateEligibility = vi.fn();
const listRecent = vi.fn();
const listForRepo = vi.fn();

vi.mock("../src/eligibility/evaluate", () => ({
  evaluateEligibility: (...args: unknown[]) => evaluateEligibility(...args)
}));

vi.mock("../src/history/createHistoryStore", () => ({
  createHistoryStore: () => ({
    listRecent: (...args: unknown[]) => listRecent(...args),
    listForRepo: (...args: unknown[]) => listForRepo(...args),
    record: vi.fn()
  })
}));

// Imported after the mocks so the routes pick up the mocked modules.
const { createApp } = await import("../src/app");

describe("app", () => {
  beforeEach(() => {
    evaluateEligibility.mockReset();
    listRecent.mockReset();
    listForRepo.mockReset();
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

  it("GET /openapi.json returns a spec describing the eligibility endpoints", async () => {
    const res = await request(createApp()).get("/openapi.json");
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe("3.0.3");
    expect(res.body.paths).toHaveProperty("/eligibility/check");
    expect(res.body.paths).toHaveProperty("/eligibility/check-batch");
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

  describe("GET /admin/evaluations", () => {
    it("lists recent evaluations across all repos by default", async () => {
      const record = { id: 1, repo: { owner: "o", repo: "r" }, evaluatedAt: "2026-01-01T00:00:00Z", eligible: true, reasons: [] };
      listRecent.mockReturnValue([record]);

      const res = await request(createApp()).get("/admin/evaluations");

      expect(res.status).toBe(200);
      expect(res.body.evaluations).toEqual([record]);
      expect(listRecent).toHaveBeenCalledWith(50);
      expect(listForRepo).not.toHaveBeenCalled();
    });

    it("filters to one repo when ?repo= is given", async () => {
      listForRepo.mockReturnValue([]);

      const res = await request(createApp()).get("/admin/evaluations").query({ repo: "o/r" });

      expect(res.status).toBe(200);
      expect(listForRepo).toHaveBeenCalledWith({ owner: "o", repo: "r" }, 50);
    });

    it("respects a custom limit", async () => {
      listRecent.mockReturnValue([]);

      await request(createApp()).get("/admin/evaluations").query({ limit: "5" });

      expect(listRecent).toHaveBeenCalledWith(5);
    });

    it("rejects a limit over the 200 cap", async () => {
      const res = await request(createApp()).get("/admin/evaluations").query({ limit: "500" });
      expect(res.status).toBe(400);
      expect(listRecent).not.toHaveBeenCalled();
    });

    it("rejects an unparseable repo query param", async () => {
      const res = await request(createApp()).get("/admin/evaluations").query({ repo: "not a repo" });
      expect(res.status).toBe(400);
      expect(listForRepo).not.toHaveBeenCalled();
    });
  });
});
