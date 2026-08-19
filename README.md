# account-updater

[![CI](https://github.com/jeraldoalday/account-updater/actions/workflows/ci.yml/badge.svg)](https://github.com/jeraldoalday/account-updater/actions/workflows/ci.yml)

An HTTP service that checks whether a GitHub repo meets the eligibility
requirements to connect an account — real, actively-developed first-party
projects in an eligible language, not scaffolds or a codebase built locally
and pushed all at once. Exact thresholds live in
`src/eligibility/thresholds.ts` and are intentionally not duplicated here.
The five known languages (TypeScript, JavaScript, Python, Go, Rust) can be
narrowed further via `ELIGIBLE_LANGUAGES` — see `.env.example`.

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
   check. Transient failures (5xx, secondary rate limiting) are retried with
   exponential backoff before giving up.
3. Calls the GitHub Events API for recent push events (best-effort, GitHub
   only retains ~90 days / 300 events) as a secondary signal.
4. Scores "organically developed vs. bulk-pushed" as a weighted blend of
   four signals rather than an independent pass/fail per signal: commits
   should land across many distinct days with no single day dominating;
   (when push-event data is available) no single push event should deliver
   most of the known commits at once; commit messages should be varied and
   descriptive rather than templated/generic; and commits should show some
   contributor diversity (scored leniently, since a single-maintainer repo
   is common and legitimate on its own). The blended score has to clear
   `THRESHOLDS.minActiveDevelopmentScore` to pass, so a repo that's mildly
   off on one signal isn't rejected the same as one that's bad on all of
   them.

The temp clone is always deleted after the scan, whether it succeeds or
fails.

## Running

```bash
cp .env.example .env   # set GITHUB_TOKEN for higher rate limits / private repos
npm install
npm run dev             # or: npm run build && npm start
```

For a higher-rate-limit shared credential than a PAT, set
`GITHUB_APP_ID`/`GITHUB_APP_PRIVATE_KEY`/`GITHUB_APP_INSTALLATION_ID`
instead of (or alongside) `GITHUB_TOKEN` — see `.env.example`. A
per-request `token` or `GITHUB_TOKEN`, when present, always takes
precedence over the App installation credential.

Or with Docker (the image includes `git`, which the service shells out to
for cloning):

```bash
docker build -t account-updater .
docker run --rm -p 3000:3000 --env-file .env account-updater
```

or `docker compose up` (reads `.env`; the image reports its own health via
`docker ps` / `HEALTHCHECK`, polling `GET /health`).

## API

The full API is described by an OpenAPI 3.0 document served at
`GET /openapi.json` (hand-maintained in `src/openapi.ts`, checked by tests
that every `$ref` resolves and that the documented request bodies match
what the routes actually accept).

If `API_KEY` is set, every `/eligibility/*` request must include a matching
`x-api-key` header, or it's rejected with 401. Leave `API_KEY` unset for
local development.

`/eligibility/*` is also rate-limited (20 requests per 60-second window by
default, keyed by API key or IP — see `RATE_LIMIT_WINDOW_MS` /
`RATE_LIMIT_MAX`), since each request clones a repo and calls the GitHub
API. Requests over the limit get a 429 with a `Retry-After` header.

Every response carries an `x-request-id` header (reusing an incoming one if
the caller sends it) for correlating a report with server logs, which are
emitted as structured JSON.

`GET /metrics` returns in-memory counters (request volume by status class,
eligibility pass/fail counts, cache hit/miss counts, and per-stage
count/avg/max duration for each evaluation stage - clone+scan, commit
history, push events - so a slow check is diagnosable by stage) —
per-process only, not aggregated across instances. The same data is also
available at `GET /metrics/prometheus` in Prometheus's text exposition
format, for scraping directly instead of polling the JSON endpoint.

`POST /eligibility/check`

```json
{ "repo": "owner/name", "token": "optional-per-request-github-token" }
```

`repo` also accepts a full URL (`https://github.com/owner/name`) or an SSH
URL, on any recognized provider (see [Providers](#providers)); bare
`owner/name` shorthand is assumed to be GitHub. `token` is optional and
overrides `GITHUB_TOKEN` for that request — useful for evaluating a private
repo using the connecting user's own OAuth token instead of a shared server
token.

Response:

```json
{
  "eligible": true,
  "repo": { "provider": "github", "owner": "owner", "repo": "name" },
  "checks": {
    "language": { "passed": true, "primaryLanguage": "TypeScript", "reasons": [] },
    "size": { "passed": true, "totalLines": 12000, "totalFiles": 80, "reasons": [] },
    "history": { "passed": true, "commitCount": 210, "historyDays": 45, "...": "..." },
    "activeDevelopment": { "passed": true, "score": 0.93, "distinctCommitDays": 30, "...": "..." }
  },
  "reasons": []
}
```

`reasons` (top-level and per-check) lists every requirement that failed, so
the caller can show the connecting user why they weren't eligible.

If GitHub itself rate-limits a request (after the client's built-in retries
are exhausted), the endpoint returns 503 with a `Retry-After` header and a
`rateLimit` object (`remaining`, `resetAt`, `retryAfterSeconds`, any of
which may be absent if GitHub didn't report them) instead of a generic 502,
so callers can back off intelligently rather than retrying immediately.

`POST /eligibility/check-batch`

```json
{ "repos": ["owner/name-1", "owner/name-2"], "token": "optional-per-request-github-token" }
```

Checks up to 20 repos in one request (3 at a time), returning
`{ "results": [...] }` in the same order as `repos`. Each entry is either a
normal eligibility result or `{ "repo": "...", "error": "...", "rateLimit"?: {...} }`
— one repo failing (a typo, a private repo the token can't see, a
rate-limited GitHub call) doesn't fail the rest of the batch.

Results are cached per repo for `CACHE_TTL_MS` (default 10 minutes) to avoid
re-cloning and re-hitting the GitHub API on repeat checks. A request that
supplies its own `token` is never cached, since a cached result could
otherwise leak a private repo's outcome to a caller who supplied a
different token.

The cache backend is `memory` by default (per-process, lost on restart —
fine for a single instance). Set `CACHE_BACKEND=redis` and `REDIS_URL` to
share cached results across multiple instances of the service instead.

Concurrent cacheable requests for the same repo that all miss the cache
share a single in-flight computation rather than each cloning and
re-checking the repo independently.

Every evaluation actually performed (a cache hit doesn't count again) is
recorded to a SQLite audit trail — repo, timestamp, eligible, reasons — at
`HISTORY_DB_PATH` (default `./data/history.db`), so a past result stays
answerable later rather than only visible as a live snapshot.

`GET /admin/evaluations` reads that audit trail back over the API (gated by
the same `x-api-key` requirement as `/eligibility/*`, when `API_KEY` is
set). Optional `?repo=owner/name` filters to one repo, and `?limit=` caps
the result count (default 50, max 200). Results are most-recent-first.

## Providers

Repo references carry the provider they belong to, rather than every layer
assuming GitHub. Two lists matter, and they're deliberately different:

- **Recognized** (`src/providers/hosts.ts`): GitHub, GitLab, Bitbucket. A
  URL on any of these parses into a `{ provider, owner, repo }` reference.
- **Implemented** (`src/providers/registry.ts`): GitHub only. A recognized
  but unimplemented provider is rejected with a 400 naming it, rather than
  a parse error or a 502 that invites a pointless retry.

Adding a forge means writing a `RepoProvider` — a commit-history summary
and a push-event summary, the only two things the eligibility checks need
from a forge — and registering it. Cloning, caching, the audit trail, and
the checks themselves need no change: clone URLs and token placeholder
usernames come from the host table, and cache keys and audit rows are
already provider-scoped, so `acme/widgets` on two forges stays two
distinct projects throughout.

The push-event method is best-effort by contract: a forge without such an
API reports `available: false`, and the activity check treats a missing
signal as neutral rather than disqualifying.

## Known limitations

- The commit-day histogram and push-event checks are heuristics, not proof:
  a determined bad actor could fake commit dates spread across many days.
  These checks are meant to catch the common "built locally, pushed once"
  case, not to be adversarially airtight.
- GitHub's push-event data is short-lived (~90 days / 300 events) and mixes
  in non-push activity, so `pushEvents.available` may be `true` with zero
  observed pushes for older or very active repos; the eligibility decision
  never depends on push-event data being present.
- GitLab and Bitbucket URLs parse but cannot be evaluated yet — only the
  seam exists, not an implementation.
- The size/line-count check counts raw lines (including blank lines and
  comments) in files under the five eligible languages' extensions.

## Testing

```bash
npm test        # unit tests (vitest) — no network access required
npm run typecheck
```
