# account-updater

An HTTP service that checks whether a GitHub repo meets the eligibility
requirements to connect an account — real, actively-developed first-party
projects in an eligible language, not scaffolds or a codebase built locally
and pushed all at once. Exact thresholds live in
`src/eligibility/thresholds.ts` and are intentionally not duplicated here.

## How it works

For a given repo, the service:

1. Shallow-clones (`--depth 1`) the default branch into a temp dir and scans
   the current file tree, counting lines/files per language after excluding
   vendor/build/generated paths (`node_modules`, `dist`, `target`, lockfiles,
   minified files, etc). This gives the primary-language and size checks.
2. Calls the GitHub API for the commit history: exact commit count and
   first/last commit dates (via the `Link` header on `per_page=1` requests,
   so this is cheap even on huge repos), plus a sampled day-by-day commit
   histogram (capped at the most recent 500 commits) for the history-span
   check.
3. Calls the GitHub Events API for recent push events (best-effort, GitHub
   only retains ~90 days / 300 events) as a secondary signal.
4. Approximates "organically developed vs. bulk-pushed" using two signals:
   commits should land across many distinct days with no single day
   dominating, and (when push-event data is available) no single push event
   should account for most of the known commits at once.

The temp clone is always deleted after the scan, whether it succeeds or
fails.

## Running

```bash
cp .env.example .env   # set GITHUB_TOKEN for higher rate limits / private repos
npm install
npm run dev             # or: npm run build && npm start
```

## API

If `API_KEY` is set, every `/eligibility/*` request must include a matching
`x-api-key` header, or it's rejected with 401. Leave `API_KEY` unset for
local development.

`POST /eligibility/check`

```json
{ "repo": "owner/name", "token": "optional-per-request-github-token" }
```

`repo` also accepts a full GitHub URL (`https://github.com/owner/name`) or an
SSH URL. `token` is optional and overrides `GITHUB_TOKEN` for that request —
useful for evaluating a private repo using the connecting user's own OAuth
token instead of a shared server token.

Response:

```json
{
  "eligible": true,
  "repo": { "owner": "owner", "repo": "name" },
  "checks": {
    "language": { "passed": true, "primaryLanguage": "TypeScript", "reasons": [] },
    "size": { "passed": true, "totalLines": 12000, "totalFiles": 80, "reasons": [] },
    "history": { "passed": true, "commitCount": 210, "historyDays": 45, "...": "..." },
    "activeDevelopment": { "passed": true, "distinctCommitDays": 30, "...": "..." }
  },
  "reasons": []
}
```

`reasons` (top-level and per-check) lists every requirement that failed, so
the caller can show the connecting user why they weren't eligible.

## Known limitations

- The commit-day histogram and push-event checks are heuristics, not proof:
  a determined bad actor could fake commit dates spread across many days.
  These checks are meant to catch the common "built locally, pushed once"
  case, not to be adversarially airtight.
- GitHub's push-event data is short-lived (~90 days / 300 events) and mixes
  in non-push activity, so `pushEvents.available` may be `true` with zero
  observed pushes for older or very active repos; the eligibility decision
  never depends on push-event data being present.
- The size/line-count check counts raw lines (including blank lines and
  comments) in files under the five eligible languages' extensions.

## Testing

```bash
npm test        # unit tests (vitest) — no network access required
npm run typecheck
```
