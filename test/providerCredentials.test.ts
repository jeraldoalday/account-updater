import { afterEach, describe, expect, it, vi } from "vitest";

const ENV_KEYS = ["GITHUB_TOKEN", "GITLAB_TOKEN", "BITBUCKET_TOKEN"] as const;
const originalEnv = { ...process.env };

async function loadWith(overrides: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  vi.resetModules();
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, overrides);
  return import("../src/providers/credentials");
}

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, originalEnv);
  vi.resetModules();
});

/**
 * The rule this file exists to hold: a credential configured for one forge
 * is never the answer for another. Before GitLab was implemented the HTTP
 * layer defaulted every request to GITHUB_TOKEN, which was harmless while
 * every ref was a GitHub ref and would have sent a GitHub PAT to gitlab.com
 * the day one wasn't.
 */
describe("defaultTokenFor", () => {
  it("gives each forge its own configured credential", async () => {
    const { defaultTokenFor } = await loadWith({
      GITHUB_TOKEN: "ghp_github",
      GITLAB_TOKEN: "glpat_gitlab",
      BITBUCKET_TOKEN: "bbat_bitbucket"
    });

    expect(defaultTokenFor("github")).toBe("ghp_github");
    expect(defaultTokenFor("gitlab")).toBe("glpat_gitlab");
    expect(defaultTokenFor("bitbucket")).toBe("bbat_bitbucket");
  });

  it("never hands one forge's token to another", async () => {
    const { defaultTokenFor } = await loadWith({ GITHUB_TOKEN: "ghp_github" });

    expect(defaultTokenFor("gitlab")).toBeUndefined();
    expect(defaultTokenFor("bitbucket")).toBeUndefined();
  });

  it("returns undefined - unauthenticated - rather than any token when none is configured", async () => {
    const { defaultTokenFor } = await loadWith({});

    expect(defaultTokenFor("github")).toBeUndefined();
    expect(defaultTokenFor("gitlab")).toBeUndefined();
    expect(defaultTokenFor("bitbucket")).toBeUndefined();
  });

  it("resolves a credential for every forge the host table knows", async () => {
    // The switch is exhaustive on purpose: a forge added to the table
    // without a decision about its credential should not quietly become
    // "unauthenticated forever". This asserts the set stays in step.
    const { defaultTokenFor } = await loadWith({
      GITHUB_TOKEN: "ghp_github",
      GITLAB_TOKEN: "glpat_gitlab",
      BITBUCKET_TOKEN: "bbat_bitbucket"
    });
    const { PROVIDER_IDS } = await import("../src/providers/hosts");

    for (const id of PROVIDER_IDS) {
      expect(defaultTokenFor(id)).toBeTruthy();
    }
  });
});
