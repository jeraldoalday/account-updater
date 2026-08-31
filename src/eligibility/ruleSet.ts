import { createHash } from "node:crypto";
import { version } from "../version";
import { ALLOWED_LANGUAGES, KNOWN_LANGUAGES, THRESHOLDS, type AllowedLanguage } from "./thresholds";

/**
 * Everything that decides a verdict, gathered into one value.
 *
 * The eligibility checks read `THRESHOLDS` and `ALLOWED_LANGUAGES`
 * directly, which is fine for computing a result and useless for talking
 * *about* one: nothing could answer "what bar was this repo measured
 * against?" without restating the thresholds by hand somewhere else and
 * hoping the two stayed in step. This is the single description both the
 * fingerprint below and `GET /rules` are built from.
 */
export interface RuleSet {
  /** The build that produced the verdict. See `ruleSetFingerprint`. */
  version: string;
  /** Languages this build can recognize at all. */
  knownLanguages: readonly AllowedLanguage[];
  /** The subset a repo's primary language must be in, via ELIGIBLE_LANGUAGES. */
  eligibleLanguages: readonly AllowedLanguage[];
  thresholds: typeof THRESHOLDS;
}

export function describeRuleSet(): RuleSet {
  return {
    version,
    knownLanguages: KNOWN_LANGUAGES,
    eligibleLanguages: ALLOWED_LANGUAGES,
    thresholds: THRESHOLDS
  };
}

/**
 * JSON with object keys in sorted order, so the same rule set always
 * serializes to the same bytes.
 *
 * `JSON.stringify` emits keys in insertion order, which makes a
 * fingerprint sensitive to the order properties happen to be written in
 * the source. Reordering two threshold fields is a no-op change that would
 * otherwise invalidate every cached result on the next deploy - and, worse,
 * do it silently, so the one time it mattered nobody would be able to tell
 * it apart from a real rule change.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, v]) => `${JSON.stringify(key)}:${stableStringify(v)}`);
  return `{${entries.join(",")}}`;
}

/**
 * A short, stable identifier for "the rules a verdict was computed under".
 *
 * Truncated to 16 hex characters: this is a cache-namespace token and a
 * label in an API response, not a security boundary, and a full digest
 * makes both the Redis keyspace and the response noisier for no benefit.
 */
export function computeRuleSetFingerprint(rules: RuleSet): string {
  return createHash("sha256").update(stableStringify(rules)).digest("hex").slice(0, 16);
}

/**
 * The fingerprint of the rules this process enforces.
 *
 * Cached results are namespaced by it (see `evaluate.ts`) because a cached
 * verdict is only meaningful alongside the rules that produced it, and
 * nothing else was keeping the two together. Two ways that bit:
 *
 * - An operator narrows ELIGIBLE_LANGUAGES, or raises a threshold, and
 *   restarts. Every repo evaluated in the last CACHE_TTL_MS keeps being
 *   answered from a verdict computed under the old rules - including repos
 *   that the new rules reject.
 * - A rolling deploy runs two builds against one Redis. Whichever instance
 *   evaluates a repo first writes the verdict both of them then serve, so
 *   the answer a caller gets depends on which instance happened to warm the
 *   key. This is the worse of the two: it doesn't clear when the TTL
 *   expires, it just re-rolls the dice.
 *
 * `version` is part of the fingerprint for the second case. Scoring code
 * can change a verdict without any threshold moving, and the build number
 * is the only thing that reliably changes when it does. The cost is that a
 * release starts cold, which is one TTL window of extra clones - much
 * cheaper than serving one build's verdicts from another build's rules.
 */
export const RULE_SET_FINGERPRINT: string = computeRuleSetFingerprint(describeRuleSet());
