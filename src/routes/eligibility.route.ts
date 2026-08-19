import { Router } from "express";
import { z } from "zod";
import { parseRepoRef } from "../utils/repoUrl";
import { evaluateEligibility } from "../eligibility/evaluate";
import { extractRateLimitInfo, type RateLimitInfo } from "../github/rateLimitInfo";
import { UnsupportedProviderError } from "../providers/provider";
import { describeRef } from "../providers/hosts";
import { mapWithConcurrency } from "../utils/concurrency";
import { config } from "../config";
import type { EligibilityResult, RepoRef } from "../types";

const REPO_REQUIRED_MESSAGE = 'repo is required (e.g. "owner/name" or a GitHub URL)';

// Each repo in a batch clones the repo and hits the GitHub API, so both
// caps exist to keep a single request from being able to trigger unbounded
// work.
const MAX_BATCH_SIZE = 20;
const BATCH_CONCURRENCY = 3;

const requestSchema = z.object({
  repo: z.string({ required_error: REPO_REQUIRED_MESSAGE }).min(1, REPO_REQUIRED_MESSAGE),
  // Optional per-request token, e.g. the connecting user's own GitHub OAuth
  // token, so private repos can be evaluated without a shared server token.
  token: z.string().optional()
});

const batchRequestSchema = z.object({
  repos: z
    .array(z.string().min(1, REPO_REQUIRED_MESSAGE))
    .min(1, "repos must contain at least one entry")
    .max(MAX_BATCH_SIZE, `repos cannot contain more than ${MAX_BATCH_SIZE} entries`),
  token: z.string().optional()
});

type EligibilityOutcome =
  | { ok: true; result: EligibilityResult }
  | { ok: false; status: number; error: string; rateLimit?: RateLimitInfo };

async function tryEvaluate(
  ref: RepoRef,
  token: string | undefined,
  cacheable: boolean
): Promise<EligibilityOutcome> {
  try {
    const result = await evaluateEligibility(ref, token, { cacheable });
    return { ok: true, result };
  } catch (err) {
    // A forge this service can name but not evaluate is a problem with the
    // request, not with an upstream - answer 400 rather than 502 so the
    // caller doesn't retry something that can never succeed.
    if (err instanceof UnsupportedProviderError) {
      return { ok: false, status: 400, error: (err as Error).message };
    }

    const rateLimit = extractRateLimitInfo(err);
    if (rateLimit) {
      return {
        ok: false,
        status: 503,
        error: `GitHub API rate limit hit while evaluating ${describeRef(ref)}. Try again later.`,
        rateLimit
      };
    }

    return {
      ok: false,
      status: 502,
      error: `Could not evaluate ${describeRef(ref)}: ${(err as Error).message}`
    };
  }
}

export const eligibilityRouter = Router();

eligibilityRouter.post("/check", async (req, res) => {
  const parsed = requestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join("; ") });
    return;
  }

  let ref;
  try {
    ref = parseRepoRef(parsed.data.repo);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
    return;
  }

  const token = parsed.data.token ?? config.githubToken;
  // Never cache a result computed with a caller-supplied token — it may
  // reflect access to a private repo that other callers don't have.
  const cacheable = !parsed.data.token;

  const outcome = await tryEvaluate(ref, token, cacheable);
  if (!outcome.ok) {
    if (outcome.rateLimit?.retryAfterSeconds !== undefined) {
      res.setHeader("Retry-After", String(outcome.rateLimit.retryAfterSeconds));
    }
    res.status(outcome.status).json({
      error: outcome.error,
      ...(outcome.rateLimit ? { rateLimit: outcome.rateLimit } : {})
    });
    return;
  }

  res.status(200).json(outcome.result);
});

eligibilityRouter.post("/check-batch", async (req, res) => {
  const parsed = batchRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join("; ") });
    return;
  }

  const token = parsed.data.token ?? config.githubToken;
  const cacheable = !parsed.data.token;

  const results = await mapWithConcurrency(
    parsed.data.repos,
    BATCH_CONCURRENCY,
    async (repoInput) => {
      let ref: RepoRef;
      try {
        ref = parseRepoRef(repoInput);
      } catch (err) {
        return { repo: repoInput, error: (err as Error).message };
      }

      const outcome = await tryEvaluate(ref, token, cacheable);
      if (!outcome.ok) {
        return {
          repo: describeRef(ref),
          error: outcome.error,
          ...(outcome.rateLimit ? { rateLimit: outcome.rateLimit } : {})
        };
      }

      return outcome.result;
    }
  );

  res.status(200).json({ results });
});
