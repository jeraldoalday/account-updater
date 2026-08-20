import { Router } from "express";
import { z } from "zod";
import { parseRepoRef } from "../utils/repoUrl";
import { createHistoryStore } from "../history/createHistoryStore";
import type { RepoRef } from "../types";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const DEFAULT_TOP_REASONS = 5;
const MAX_TOP_REASONS = 20;

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

const summaryQuerySchema = querySchema
  .omit({ eligible: true, limit: true })
  .extend({ topReasons: z.coerce.number().int().positive().max(MAX_TOP_REASONS).optional() });

/**
 * Shared by both admin routes: `repo` arrives as free text and has to
 * parse into a provider-scoped ref before it can filter anything, and an
 * unparseable one is a 400 rather than a filter that matches nothing.
 */
function parseRepoFilter(repo: string | undefined): { ref?: RepoRef; error?: string } {
  if (repo === undefined) return {};
  try {
    return { ref: parseRepoRef(repo) };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

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

  const { ref, error } = parseRepoFilter(repo);
  if (error) {
    res.status(400).json({ error });
    return;
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

// The per-evaluation list answers "what happened to this repo". This
// answers the questions the trail is usually opened for - has the pass
// rate moved, and which check is doing the rejecting - which otherwise
// mean paging through rows and counting them by hand.
adminRouter.get("/evaluations/summary", (req, res) => {
  const parsed = summaryQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join("; ") });
    return;
  }

  const { repo, since, until, topReasons } = parsed.data;

  const { ref, error } = parseRepoFilter(repo);
  if (error) {
    res.status(400).json({ error });
    return;
  }

  const summary = createHistoryStore().summarize({
    ...(ref ? { ref } : {}),
    ...(since !== undefined ? { since } : {}),
    ...(until !== undefined ? { until } : {}),
    topN: topReasons ?? DEFAULT_TOP_REASONS
  });

  res.status(200).json(summary);
});
