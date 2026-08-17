import { Router } from "express";
import { z } from "zod";
import { parseRepoRef } from "../utils/repoUrl";
import { createHistoryStore } from "../history/createHistoryStore";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const querySchema = z.object({
  repo: z.string().min(1).optional(),
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

  const limit = parsed.data.limit ?? DEFAULT_LIMIT;
  const historyStore = createHistoryStore();

  if (parsed.data.repo) {
    let ref;
    try {
      ref = parseRepoRef(parsed.data.repo);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }
    res.status(200).json({ evaluations: historyStore.listForRepo(ref, limit) });
    return;
  }

  res.status(200).json({ evaluations: historyStore.listRecent(limit) });
});
