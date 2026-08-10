import { afterEach, describe, expect, it, vi } from "vitest";

const originalEnv = { ...process.env };

async function loadThresholdsWith(eligibleLanguages: string | undefined) {
  vi.resetModules();
  delete process.env.ELIGIBLE_LANGUAGES;
  if (eligibleLanguages !== undefined) process.env.ELIGIBLE_LANGUAGES = eligibleLanguages;
  return import("../src/eligibility/thresholds");
}

afterEach(() => {
  delete process.env.ELIGIBLE_LANGUAGES;
  Object.assign(process.env, originalEnv);
  vi.resetModules();
});

describe("ALLOWED_LANGUAGES", () => {
  it("defaults to all known languages when unset", async () => {
    const { ALLOWED_LANGUAGES, KNOWN_LANGUAGES } = await loadThresholdsWith(undefined);
    expect(ALLOWED_LANGUAGES).toEqual(KNOWN_LANGUAGES);
  });

  it("narrows to the requested subset", async () => {
    const { ALLOWED_LANGUAGES } = await loadThresholdsWith("TypeScript, Python");
    expect(ALLOWED_LANGUAGES).toEqual(["TypeScript", "Python"]);
  });

  it("defaults to all known languages when set to a blank string", async () => {
    const { ALLOWED_LANGUAGES, KNOWN_LANGUAGES } = await loadThresholdsWith("   ");
    expect(ALLOWED_LANGUAGES).toEqual(KNOWN_LANGUAGES);
  });

  it("throws on an unrecognized language name", async () => {
    await expect(loadThresholdsWith("TypeScript,COBOL")).rejects.toThrow(/unknown language.*COBOL/i);
  });
});
