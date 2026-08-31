import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { describeRules } from "../src/routes/rules.route";
import { RULE_SET_FINGERPRINT } from "../src/eligibility/ruleSet";
import { ALLOWED_LANGUAGES, KNOWN_LANGUAGES, THRESHOLDS } from "../src/eligibility/thresholds";
import { version } from "../src/version";

vi.mock("../src/history/createHistoryStore", () => ({
  createHistoryStore: () => ({ record: vi.fn(), list: () => [], ping: () => undefined })
}));

const { createApp } = await import("../src/app");

describe("describeRules", () => {
  // The whole point of serving this is that an integrator can rely on it
  // instead of on a number someone typed into their own docs. If a
  // threshold is added and this doesn't grow with it, the endpoint has
  // started lying by omission.
  it("publishes every threshold the checks enforce, with no restatement in between", () => {
    expect(describeRules().thresholds).toEqual(THRESHOLDS);
  });

  it("reports both the languages it knows and the ones it accepts", () => {
    const { languages } = describeRules();
    expect(languages.known).toEqual(KNOWN_LANGUAGES);
    expect(languages.eligible).toEqual(ALLOWED_LANGUAGES);
  });

  it("carries the fingerprint cached verdicts are namespaced by", () => {
    expect(describeRules().fingerprint).toBe(RULE_SET_FINGERPRINT);
  });

  it("names the build the rules belong to", () => {
    expect(describeRules().version).toBe(version);
  });
});

describe("GET /rules", () => {
  it("answers with the rules in force", async () => {
    const res = await request(createApp()).get("/rules");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(JSON.parse(JSON.stringify(describeRules())));
  });

  it("names the size and history bar a caller has to clear", async () => {
    const res = await request(createApp()).get("/rules");

    expect(res.body.thresholds.minLines).toBe(THRESHOLDS.minLines);
    expect(res.body.thresholds.minCommits).toBe(THRESHOLDS.minCommits);
    expect(res.body.thresholds.minHistoryDays).toBe(THRESHOLDS.minHistoryDays);
  });

  it("publishes the signal weights, so a near-miss score is reproducible", async () => {
    const res = await request(createApp()).get("/rules");

    expect(res.body.thresholds.activeDevelopmentWeights).toEqual(
      THRESHOLDS.activeDevelopmentWeights
    );
    expect(res.body.thresholds.minActiveDevelopmentScore).toBe(
      THRESHOLDS.minActiveDevelopmentScore
    );
  });

  // Like /providers: this is a client asking what it may send before it
  // sends anything, so requiring a key to answer it just moves the failure
  // one step later.
  it("does not require an API key", async () => {
    const res = await request(createApp()).get("/rules");

    expect(res.status).not.toBe(401);
  });

  it("is not answered for an unknown path under it", async () => {
    const res = await request(createApp()).get("/rules/thresholds");

    expect(res.status).toBe(404);
  });
});
