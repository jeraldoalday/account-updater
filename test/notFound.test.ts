import { describe, expect, it, vi } from "vitest";
import request from "supertest";

vi.mock("../src/history/createHistoryStore", () => ({
  createHistoryStore: () => ({ list: () => [], record: vi.fn(), ping: vi.fn() })
}));

const { createApp } = await import("../src/app");

describe("unmatched routes", () => {
  it("answers 404 as JSON, not as Express's HTML error page", async () => {
    const res = await request(createApp()).get("/eligibilty/check");

    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body.error).toContain("GET /eligibilty/check");
  });

  it("points the caller at the spec, since the mistake is usually a typo", async () => {
    const res = await request(createApp()).get("/nope");
    expect(res.body.error).toContain("/openapi.json");
  });

  it("treats a wrong method on a real path as unmatched too", async () => {
    // GET /eligibility/check exists as a POST only - Express matches the
    // mount but no route, which lands here rather than in a router.
    const res = await request(createApp()).get("/eligibility/check");

    expect(res.status).toBe(404);
    expect(res.body.error).toContain("GET /eligibility/check");
  });

  it("carries the request ID, so a 404 is traceable like any other response", async () => {
    const res = await request(createApp()).get("/nope");

    expect(typeof res.body.requestId).toBe("string");
    expect(res.body.requestId).toBe(res.headers["x-request-id"]);
  });

  it("truncates an absurdly long path instead of echoing it whole", async () => {
    const res = await request(createApp()).get(`/${"a".repeat(5_000)}`);

    expect(res.status).toBe(404);
    expect(res.body.error.length).toBeLessThan(400);
    expect(res.body.error).toContain("...");
  });

  it("still serves the routes that do exist", async () => {
    // Cheap guard against the catch-all being registered too early and
    // swallowing everything behind it.
    const res = await request(createApp()).get("/health");
    expect(res.status).toBe(200);
  });
});
