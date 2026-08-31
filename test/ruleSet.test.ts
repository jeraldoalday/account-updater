import { describe, expect, it } from "vitest";
import {
  computeRuleSetFingerprint,
  describeRuleSet,
  stableStringify,
  RULE_SET_FINGERPRINT,
  type RuleSet
} from "../src/eligibility/ruleSet";
import { ALLOWED_LANGUAGES, KNOWN_LANGUAGES, THRESHOLDS } from "../src/eligibility/thresholds";
import { version } from "../src/version";

function ruleSet(overrides: Partial<RuleSet> = {}): RuleSet {
  return { ...describeRuleSet(), ...overrides };
}

describe("stableStringify", () => {
  it("serializes the same object identically whatever order its keys were written in", () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
  });

  it("sorts keys at every depth, not only the top level", () => {
    expect(stableStringify({ outer: { z: 1, a: 2 } })).toBe('{"outer":{"a":2,"z":1}}');
  });

  it("keeps array order, which is meaningful", () => {
    expect(stableStringify(["b", "a"])).toBe('["b","a"]');
    expect(stableStringify(["b", "a"])).not.toBe(stableStringify(["a", "b"]));
  });

  it("handles the primitives a rule set can contain", () => {
    expect(stableStringify(0.8)).toBe("0.8");
    expect(stableStringify("TypeScript")).toBe('"TypeScript"');
    expect(stableStringify(null)).toBe("null");
    expect(stableStringify(true)).toBe("true");
  });

  it("drops undefined values rather than emitting them", () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe('{"a":1}');
  });
});

describe("computeRuleSetFingerprint", () => {
  it("is stable across calls on an unchanged rule set", () => {
    expect(computeRuleSetFingerprint(ruleSet())).toBe(computeRuleSetFingerprint(ruleSet()));
  });

  it("is a short hex token, not a full digest", () => {
    expect(computeRuleSetFingerprint(ruleSet())).toMatch(/^[0-9a-f]{16}$/);
  });

  // Each of these is a way a verdict computed yesterday stops meaning what
  // it said, and each one has to move the fingerprint or the cache will
  // keep serving it.
  it("changes when a numeric threshold moves", () => {
    const raised = ruleSet({
      thresholds: { ...THRESHOLDS, minCommits: THRESHOLDS.minCommits + 1 }
    });
    expect(computeRuleSetFingerprint(raised)).not.toBe(computeRuleSetFingerprint(ruleSet()));
  });

  it("changes when a signal weight moves", () => {
    const reweighted = ruleSet({
      thresholds: {
        ...THRESHOLDS,
        activeDevelopmentWeights: {
          ...THRESHOLDS.activeDevelopmentWeights,
          daySpread: THRESHOLDS.activeDevelopmentWeights.daySpread + 0.01
        }
      }
    });
    expect(computeRuleSetFingerprint(reweighted)).not.toBe(computeRuleSetFingerprint(ruleSet()));
  });

  it("changes when the eligible-language list is narrowed", () => {
    const narrowed = ruleSet({ eligibleLanguages: ["TypeScript"] });
    expect(computeRuleSetFingerprint(narrowed)).not.toBe(computeRuleSetFingerprint(ruleSet()));
  });

  // The rolling-deploy case: two builds sharing one Redis must not read
  // each other's verdicts, even when every threshold is identical, because
  // scoring code can change a verdict without any number moving.
  it("changes when the build does, with the rules held fixed", () => {
    const next = ruleSet({ version: `${version}-next` });
    expect(computeRuleSetFingerprint(next)).not.toBe(computeRuleSetFingerprint(ruleSet()));
  });

  it("ignores the order the rule set's own properties are written in", () => {
    const rules = describeRuleSet();
    const reordered = {
      thresholds: rules.thresholds,
      eligibleLanguages: rules.eligibleLanguages,
      knownLanguages: rules.knownLanguages,
      version: rules.version
    } as RuleSet;
    expect(computeRuleSetFingerprint(reordered)).toBe(computeRuleSetFingerprint(rules));
  });
});

describe("describeRuleSet", () => {
  it("reports the thresholds and languages this build actually enforces", () => {
    const rules = describeRuleSet();
    expect(rules.thresholds).toEqual(THRESHOLDS);
    expect(rules.knownLanguages).toEqual(KNOWN_LANGUAGES);
    expect(rules.eligibleLanguages).toEqual(ALLOWED_LANGUAGES);
    expect(rules.version).toBe(version);
  });
});

describe("RULE_SET_FINGERPRINT", () => {
  it("is the fingerprint of this process's own rules", () => {
    expect(RULE_SET_FINGERPRINT).toBe(computeRuleSetFingerprint(describeRuleSet()));
  });
});
