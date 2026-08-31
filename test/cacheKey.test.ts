import { describe, expect, it, vi } from "vitest";
import { RULE_SET_FINGERPRINT } from "../src/eligibility/ruleSet";

vi.mock("../src/history/createHistoryStore", () => ({
  createHistoryStore: () => ({ record: vi.fn() })
}));

const { cacheKeyFor } = await import("../src/eligibility/evaluate");

const ref = { provider: "github" as const, owner: "acme", repo: "widgets" };

describe("cacheKeyFor", () => {
  it("scopes a key to the forge, so two repos of the same name don't collide", () => {
    expect(cacheKeyFor(ref)).not.toBe(cacheKeyFor({ ...ref, provider: "gitlab" }));
  });

  it("scopes a key to the rules the verdict was computed under", () => {
    expect(cacheKeyFor(ref)).toContain(RULE_SET_FINGERPRINT);
  });

  it("names the repo it is for", () => {
    expect(cacheKeyFor(ref)).toBe(`${RULE_SET_FINGERPRINT}/github/acme/widgets`);
  });

  it("keeps a nested GitLab namespace intact", () => {
    const nested = { provider: "gitlab" as const, owner: "group/subgroup", repo: "widgets" };
    expect(cacheKeyFor(nested)).toBe(`${RULE_SET_FINGERPRINT}/gitlab/group/subgroup/widgets`);
  });

  it("gives the same repo the same key every time", () => {
    expect(cacheKeyFor(ref)).toBe(cacheKeyFor({ ...ref }));
  });
});
