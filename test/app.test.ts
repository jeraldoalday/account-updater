import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { UnsupportedProviderError } from "../src/providers/provider";

const evaluateEligibility = vi.fn();
const listEvaluations = vi.fn();

vi.mock("../src/eligibility/evaluate", () => ({
  evaluateEligibility: (...args: unknown[]) => evaluateEligibility(...args)
}));

vi.mock("../src/history/createHistoryStore", () => ({
  createHistoryStore: () => ({
    list: (...args: unknown[]) => listEvaluations(...args),
    record: vi.fn()
  })
}));

// Imported after the mocks so the routes pick up the mocked modules.
const { createApp } = await import("../src/app");

describe("app", () => {
  beforeEach(() => {
    evaluateEligibility.mockReset();
    listEvaluations.mockReset().mockReturnValue([]);
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

  it("GET /metrics/prometheus returns counters in Prometheus text-exposition format", async () => {
    const res = await request(createApp()).get("/metrics/prometheus");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/plain/);
    expect(res.text).toContain("account_updater_requests_total");
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
    const fakeResult = {
      eligible: true,
      repo: { provider: "github", owner: "o", repo: "r" },
      checks: {},
      reasons: []
    };
    evaluateEligibility.mockResolvedValue(fakeResult);

    const res = await request(createApp()).post("/eligibility/check").send({ repo: "o/r" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(fakeResult);
    expect(evaluateEligibility).toHaveBeenCalledWith(
      { provider: "github", owner: "o", repo: "r" },
      undefined,
      { cacheable: true, refresh: false }
    );
  });

  it("marks a request with its own token as non-cacheable", async () => {
    evaluateEligibility.mockResolvedValue({ eligible: false, repo: {}, checks: {}, reasons: [] });

    await request(createApp())
      .post("/eligibility/check")
      .send({ repo: "o/r", token: "caller-token" });

    expect(evaluateEligibility).toHaveBeenCalledWith(
      { provider: "github", owner: "o", repo: "r" },
      "caller-token",
      { cacheable: false, refresh: false }
    );
  });

  it("POST /eligibility/check returns 400, not 502, for a forge with no implementation", async () => {
    // The request is well-formed and the URL parses - it just names a
    // provider that can't be evaluated. Retrying will never help, so this
    // must not look like a transient upstream failure.
    evaluateEligibility.mockRejectedValue(new UnsupportedProviderError("gitlab", ["github"]));

    const res = await request(createApp())
      .post("/eligibility/check")
      .send({ repo: "https://gitlab.com/o/r" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/GitLab repositories are not supported yet/);
  });

  it("passes the parsed provider through to the evaluator", async () => {
    evaluateEligibility.mockResolvedValue({
      eligible: true,
      repo: { provider: "gitlab", owner: "o", repo: "r" },
      checks: {},
      reasons: []
    });

    await request(createApp()).post("/eligibility/check").send({ repo: "https://gitlab.com/o/r" });

    expect(evaluateEligibility).toHaveBeenCalledWith(
      { provider: "gitlab", owner: "o", repo: "r" },
      undefined,
      { cacheable: true, refresh: false }
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
    expect(res.body.error).toMatch(/GitHub API rate limit/);
    expect(res.body.rateLimit.retryAfterSeconds).toBe(42);
    expect(res.headers["retry-after"]).toBe("42");
  });

  it("names the forge that actually rate-limited the request, not always GitHub", async () => {
    // A caller told "GitHub API rate limit" about a gitlab.com repo goes
    // and checks a quota that has nothing to do with why they were
    // refused.
    evaluateEligibility.mockRejectedValue(
      Object.assign(new Error("rate limited"), {
        status: 429,
        response: { headers: { "ratelimit-remaining": "0" } }
      })
    );

    const res = await request(createApp())
      .post("/eligibility/check")
      .send({ repo: "https://gitlab.com/o/r" });

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/GitLab API rate limit hit while evaluating gitlab\.com\/o\/r/);
    expect(res.body.error).not.toMatch(/GitHub/);
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

    it("reports an unsupported provider per-entry without failing the whole batch", async () => {
      evaluateEligibility.mockImplementation(async (ref: { provider: string; repo: string }) => {
        if (ref.provider !== "github") {
          throw new UnsupportedProviderError("gitlab", ["github"]);
        }
        return { eligible: true, repo: ref, checks: {}, reasons: [] };
      });

      const res = await request(createApp())
        .post("/eligibility/check-batch")
        .send({ repos: ["o/good", "https://gitlab.com/o/other"] });

      expect(res.status).toBe(200);
      expect(res.body.results[0].eligible).toBe(true);
      expect(res.body.results[1].error).toMatch(/not supported yet/);
      // Batch entries are identified by host too, so two same-named repos
      // on different forges are distinguishable in the response.
      expect(res.body.results[1].repo).toBe("gitlab.com/o/other");
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
    const record = {
      id: 1,
      repo: { provider: "github", owner: "o", repo: "r" },
      evaluatedAt: "2026-01-01T00:00:00Z",
      eligible: true,
      reasons: []
    };

    it("lists recent evaluations across all repos by default", async () => {
      listEvaluations.mockReturnValue([record]);

      const res = await request(createApp()).get("/admin/evaluations");

      expect(res.status).toBe(200);
      expect(res.body.evaluations).toEqual([record]);
      expect(listEvaluations).toHaveBeenCalledWith({ limit: 50 });
    });

    it("filters to one repo when ?repo= is given", async () => {
      const res = await request(createApp()).get("/admin/evaluations").query({ repo: "o/r" });

      expect(res.status).toBe(200);
      expect(listEvaluations).toHaveBeenCalledWith({
        ref: { provider: "github", owner: "o", repo: "r" },
        limit: 50
      });
    });

    it("respects a custom limit", async () => {
      await request(createApp()).get("/admin/evaluations").query({ limit: "5" });

      expect(listEvaluations).toHaveBeenCalledWith({ limit: 5 });
    });

    it("filters by outcome when ?eligible= is given", async () => {
      await request(createApp()).get("/admin/evaluations").query({ eligible: "false" });

      expect(listEvaluations).toHaveBeenCalledWith({ eligible: false, limit: 50 });
    });

    it("filters by a time window, and combines it with the other filters", async () => {
      await request(createApp()).get("/admin/evaluations").query({
        repo: "o/r",
        eligible: "true",
        since: "2026-08-01T00:00:00Z",
        until: "2026-08-20T00:00:00Z",
        limit: "10"
      });

      expect(listEvaluations).toHaveBeenCalledWith({
        ref: { provider: "github", owner: "o", repo: "r" },
        eligible: true,
        since: "2026-08-01T00:00:00Z",
        until: "2026-08-20T00:00:00Z",
        limit: 10
      });
    });

    it("rejects an unparseable timestamp instead of quietly matching nothing", async () => {
      // A filter the caller mistyped should say so - an empty list reads
      // as "nothing happened", which is a different and wrong answer.
      const res = await request(createApp())
        .get("/admin/evaluations")
        .query({ since: "last tuesday" });

      expect(res.status).toBe(400);
      expect(listEvaluations).not.toHaveBeenCalled();
    });

    it("rejects a non-boolean eligible value", async () => {
      const res = await request(createApp()).get("/admin/evaluations").query({ eligible: "yes" });

      expect(res.status).toBe(400);
      expect(listEvaluations).not.toHaveBeenCalled();
    });

    it("rejects a limit over the 200 cap", async () => {
      const res = await request(createApp()).get("/admin/evaluations").query({ limit: "500" });
      expect(res.status).toBe(400);
      expect(listEvaluations).not.toHaveBeenCalled();
    });

    it("rejects an unparseable repo query param", async () => {
      const res = await request(createApp())
        .get("/admin/evaluations")
        .query({ repo: "not a repo" });
      expect(res.status).toBe(400);
      expect(listEvaluations).not.toHaveBeenCalled();
    });
  });
  it("rate-limits /admin too, and reports the budget on the response", async () => {
    // The admin read is cheap next to a clone, but it is still a database
    // scan behind an API key that is optional to configure.
    const res = await request(createApp()).get("/admin/evaluations");

    expect(res.status).toBe(200);
    expect(res.headers["x-ratelimit-limit"]).toBeDefined();
    expect(res.headers["x-ratelimit-remaining"]).toBeDefined();
  });
});
