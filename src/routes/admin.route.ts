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
// not a filter that silently matches nothing. Kept as a plain object
// (rather than already carrying the window refinement below) so the two
// routes that specialize it via .omit()/.extend() still can - only an
// object schema has those, not the ZodEffects a .refine() returns.
const baseQuerySchema = z.object({
  repo: z.string().min(1).optional(),
  eligible: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .optional(),
  since: z.string().datetime({ offset: true }).optional(),
  until: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().positive().max(MAX_LIMIT).optional()
});

// A window that closes before it opens is the same mistake an unparseable
// timestamp is - a caller filter gone wrong - and deserves the same
// treatment: a 400 naming the problem, not a query that runs and quietly
// returns nothing. Shared across all three routes below since each accepts
// its own `since`/`until` pair.
function sinceIsAfterUntil(since: string | undefined, until: string | undefined): boolean {
  if (since === undefined || until === undefined) return false;
  return new Date(since).getTime() > new Date(until).getTime();
}

const windowRefinement = {
  message: "`since` must not be after `until`",
  path: ["since"]
};

const querySchema = baseQuerySchema.refine(
  (data) => !sinceIsAfterUntil(data.since, data.until),
  windowRefinement
);

const changesQuerySchema = baseQuerySchema
  .omit({ eligible: true })
  .extend({ direction: z.enum(["became-eligible", "became-ineligible"]).optional() })
  .refine((data) => !sinceIsAfterUntil(data.since, data.until), windowRefinement);

const summaryQuerySchema = baseQuerySchema
  .omit({ eligible: true, limit: true })
  .extend({ topReasons: z.coerce.number().int().positive().max(MAX_TOP_REASONS).optional() })
  .refine((data) => !sinceIsAfterUntil(data.since, data.until), windowRefinement);

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

// The row list answers "what happened to this repo" and the summary
// answers "how often" - but the question actually asked after a threshold
// is retuned, or when a partner reports their repo started failing, is
// neither: which repos changed their mind, and which way. Answering it
// from /evaluations means pulling every row for every repo and diffing
// them by hand.
adminRouter.get("/evaluations/changes", (req, res) => {
  const parsed = changesQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join("; ") });
    return;
  }

  const { repo, since, until, direction } = parsed.data;

  const { ref, error } = parseRepoFilter(repo);
  if (error) {
    res.status(400).json({ error });
    return;
  }

  const changes = createHistoryStore().verdictChanges({
    ...(ref ? { ref } : {}),
    ...(since !== undefined ? { since } : {}),
    ...(until !== undefined ? { until } : {}),
    ...(direction !== undefined ? { direction } : {}),
    limit: parsed.data.limit ?? DEFAULT_LIMIT
  });

  res.status(200).json({ changes });
});
