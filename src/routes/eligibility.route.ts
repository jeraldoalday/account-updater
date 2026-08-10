import { Router } from "express";
import { z } from "zod";
import { parseRepoRef } from "../utils/repoUrl";
import { evaluateEligibility } from "../eligibility/evaluate";
import { extractRateLimitInfo } from "../github/rateLimitInfo";
import { config } from "../config";

const REPO_REQUIRED_MESSAGE = 'repo is required (e.g. "owner/name" or a GitHub URL)';

const requestSchema = z.object({
  repo: z
    .string({ required_error: REPO_REQUIRED_MESSAGE })
    .min(1, REPO_REQUIRED_MESSAGE),
  // Optional per-request token, e.g. the connecting user's own GitHub OAuth
  // token, so private repos can be evaluated without a shared server token.
  token: z.string().optional()
});

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

  try {
    const result = await evaluateEligibility(ref, token, { cacheable });
    res.status(200).json(result);
  } catch (err) {
    const rateLimit = extractRateLimitInfo(err);
    if (rateLimit) {
      if (rateLimit.retryAfterSeconds !== undefined) {
        res.setHeader("Retry-After", String(rateLimit.retryAfterSeconds));
      }
      res.status(503).json({
        error: `GitHub API rate limit hit while evaluating ${ref.owner}/${ref.repo}. Try again later.`,
        rateLimit
      });
      return;
    }

    res.status(502).json({
      error: `Could not evaluate ${ref.owner}/${ref.repo}: ${(err as Error).message}`
    });
  }
});
