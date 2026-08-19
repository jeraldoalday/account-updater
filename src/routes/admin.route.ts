import { Router } from "express";
import { z } from "zod";
import { parseRepoRef } from "../utils/repoUrl";
import { createHistoryStore } from "../history/createHistoryStore";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// Express gives query values as strings, so booleans and timestamps are
// parsed here rather than trusted: an unparseable `since` must be a 400,
// not a filter that silently matches nothing.
const querySchema = z.object({
  repo: z.string().min(1).optional(),
  eligible: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .optional(),
  since: z.string().datetime({ offset: true }).optional(),
  until: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().positive().max(MAX_LIMIT).optional()
});

export const adminRouter = Router();

// Read-only view over the SQLite audit trail built in evaluate.ts, so a
// past result is answerable via the API instead of only by querying the
// SQLite file directly. Gated by the same apiKeyAuth as /eligibility (see
// app.ts) - a no-op when API_KEY isn't configured, same as everywhere else.
adminRouter.get("/evaluations", (req, res) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join("; ") });
    return;
  }

  const { repo, eligible, since, until } = parsed.data;

  let ref;
  if (repo !== undefined) {
    try {
      ref = parseRepoRef(repo);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }
  }

  const evaluations = createHistoryStore().list({
    ...(ref ? { ref } : {}),
    ...(eligible !== undefined ? { eligible } : {}),
    ...(since !== undefined ? { since } : {}),
    ...(until !== undefined ? { until } : {}),
    limit: parsed.data.limit ?? DEFAULT_LIMIT
  });

  res.status(200).json({ evaluations });
});
