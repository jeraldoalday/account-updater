import { Router } from "express";
import { describeRuleSet, RULE_SET_FINGERPRINT } from "../eligibility/ruleSet";
import type { THRESHOLDS } from "../eligibility/thresholds";
import type { AllowedLanguage } from "../types";

export interface RulesResponse {
  /**
   * Identifies this exact rule set. The same token namespaces cached
   * verdicts, so two responses carrying the same fingerprint were decided
   * by the same rules, and a caller comparing an old result against a new
   * one can tell "the repo changed" apart from "the bar moved".
   */
  fingerprint: string;
  version: string;
  languages: {
    /** Every language this build can identify in a repo. */
    known: readonly AllowedLanguage[];
    /** The subset a repo's primary language must be one of. */
    eligible: readonly AllowedLanguage[];
  };
  thresholds: typeof THRESHOLDS;
}

/**
 * The bar, as this build actually enforces it.
 *
 * Served straight off the same rule set the checks read, with no
 * restatement in between - a hand-written copy of the thresholds is a copy
 * that goes stale, and an integrator acting on stale numbers is worse off
 * than one who was told nothing.
 */
export function describeRules(): RulesResponse {
  const rules = describeRuleSet();
  return {
    fingerprint: RULE_SET_FINGERPRINT,
    version: rules.version,
    languages: { known: rules.knownLanguages, eligible: rules.eligibleLanguages },
    thresholds: rules.thresholds
  };
}

export const rulesRouter = Router();

// Unauthenticated and outside the /eligibility rate limit, for the same
// reason /providers is: a client asking what it will be measured against
// has not asked for a repo to be evaluated yet, and answering is far
// cheaper than having it submit and be refused.
//
// The numbers were never a secret to begin with - a rejection already
// names them ("Only 12 commits found (need at least 140)"), so the only
// thing withholding them here would buy is that a caller has to fail once
// to learn the bar. What it buys instead: a caller can show a contributor
// what is missing before anything is submitted, and CACHE_TTL_MS worth of
// verdicts stop being unexplainable when an operator retunes a threshold,
// because the fingerprint moves with it.
rulesRouter.get("/", (_req, res) => {
  res.status(200).json(describeRules());
});
