import { Router } from "express";
import { z } from "zod";
import { parseRepoRef } from "../utils/repoUrl";
import { evaluateEligibility } from "../eligibility/evaluate";
import { config } from "../config";

const requestSchema = z.object({
  repo: z.string().min(1, "repo is required (e.g. \"owner/name\" or a GitHub URL)"),
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

  try {
    const result = await evaluateEligibility(ref, token);
    res.status(200).json(result);
  } catch (err) {
    res.status(502).json({
      error: `Could not evaluate ${ref.owner}/${ref.repo}: ${(err as Error).message}`
    });
  }
});
