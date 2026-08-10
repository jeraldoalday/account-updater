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

  it("GET /health returns ok", async () => {
    const res = await request(createApp()).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
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
    expect(evaluateEligibility).toHaveBeenCalledWith({ owner: "o", repo: "r" }, undefined);
  });

  it("POST /eligibility/check returns 502 when evaluation fails", async () => {
    evaluateEligibility.mockRejectedValue(new Error("boom"));

    const res = await request(createApp()).post("/eligibility/check").send({ repo: "o/r" });

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/boom/);
  });

  it("rejects a malformed JSON body", async () => {
    const res = await request(createApp())
      .post("/eligibility/check")
      .set("Content-Type", "application/json")
      .send("{not json");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/valid JSON/);
  });
});
