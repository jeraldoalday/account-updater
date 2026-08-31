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
cp .env.example .env   # set GITHUB_TOKEN / GITLAB_TOKEN / BITBUCKET_TOKEN: higher rate limits, private repos
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

After deploying, `npm run smoke -- --url https://your-instance` drives the
running service end to end against real public repos: liveness, readiness,
the spec, an eligibility check per repo, a rejected reference, and the
audit trail having recorded the checks it just made. The unit and
integration suites run against fakes on purpose, so they pass whether or
not the deployed service can shell out to `git`, reach GitHub, or write
its database — this is the check that covers that gap. It asserts the
_shape_ of each result rather than a verdict, since whether a given public
repo is eligible today is GitHub's business and the thresholds'. `--url`
and `--api-key` default to `SMOKE_URL` / `SMOKE_API_KEY`.

Before deploying, `npm run doctor` reviews the configuration the current
environment would start the service with, without starting it: no API key
on an endpoint that clones arbitrary repos, no GitHub credential (60
unauthenticated requests an hour), an audit trail written under `/tmp`,
retention disabled, a shutdown with no drain window. It exits non-zero on
a critical finding, so a release pipeline can gate on it; warnings and
notes are printed but don't fail the run, since several of them are
reasonable choices for a single-instance deployment. The same review runs
at startup and logs anything above informational.

## API

The full API is described by an OpenAPI 3.0 document served at
`GET /openapi.json` (hand-maintained in `src/openapi.ts`, checked by tests
that every `$ref` resolves, that the documented request bodies match what
the routes actually accept, that every route the app serves is documented
and vice versa, and that the documented counters match what `/metrics`
returns).

To try the endpoints without assembling requests by hand, import
[`docs/postman_collection.json`](docs/postman_collection.json) into Postman
or Insomnia — it's generated from that spec by `npm run collection`, with
runnable example bodies and the base URL and API key as collection
variables. A test fails if the committed copy drifts from the spec.

If `API_KEY` is set, every `/eligibility/*` request must include a matching
`x-api-key` header, or it's rejected with 401. Leave `API_KEY` unset for
local development.

`/eligibility/*` is also rate-limited (20 repos per 60-second window by
default — see `RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX`), since each
repo checked clones a repo and calls the provider's API. The budget is
counted in repos rather than requests: a single check spends one unit, and
a batch spends one per repo it lists. That endpoint exists so a caller
holding a list doesn't have to make twenty round trips, not so it can cause
twenty times the work on the same allowance. Requests over the limit
get a 429 with a `Retry-After` header. Every response — not just the 429 —
carries `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and
`X-RateLimit-Reset` (unix seconds), so a caller can pace itself instead of
discovering the limit by being refused. `/admin/*` is limited on the same
settings but with its own budget: an admin read is cheap next to a clone,
so hammering it shouldn't spend the expensive endpoint's allowance. A caller presenting the configured
`API_KEY` gets its own budget; everyone else is limited per remote IP. An
`x-api-key` header that doesn't match the configured key is ignored for
bucketing, so a caller can't rotate the header to escape the limit.

Every response carries an `x-request-id` header (reusing an incoming one if
the caller sends it) for correlating a report with server logs, which are
emitted as structured JSON.

`GET /health` reports that the process is alive (and is what the Docker
`HEALTHCHECK` polls). `GET /ready` answers the different question of
whether this instance should be sent traffic: it checks the cache backend
and the SQLite audit trail, and returns 503 with a per-dependency reason
when either is unusable. The two are separate because both of those
failures are non-fatal per request by design — a cache error degrades to a
miss, an audit-trail write failure is swallowed — so a degraded instance
would otherwise look perfectly healthy while paying full clone and API
cost on every request.

`GET /providers` lists the forges this build recognizes, which of them it
can evaluate, an example reference for each, and which signals each forge's
API contributes. It needs no API key and is not rate-limited: it reads two
in-memory tables, and a client asking what it may send has not sent
anything yet.

`GET /rules` publishes the bar a repo is measured against: the size,
history, and active-development thresholds, the per-signal weights behind
the blended active-development score, and which languages count. Served
from the same values the checks read, so it cannot describe a bar the
service doesn't enforce, and a test fails if a threshold is added without
appearing there. It needs no API key either — a caller who can be told
what is missing before submitting doesn't have to learn the bar one
rejection at a time. The `fingerprint` it carries identifies the rule set,
so two results carrying the same one were decided by the same rules: a
verdict that changed can be read as the repo moving rather than the bar.

`GET /metrics` returns in-memory counters (request volume by status class,
eligibility pass/fail counts both in total and split by forge, cache
hit/miss counts, and per-stage count/avg/max duration for each evaluation
stage - clone+scan, commit history, push events - so a slow check is
diagnosable by stage, and each forge's circuit-breaker state) —
per-process only, not aggregated across instances. The same data is also
available at `GET /metrics/prometheus` in Prometheus's text exposition
format, for scraping directly instead of polling the JSON endpoint.

`POST /eligibility/check`

```json
{ "repo": "owner/name", "token": "optional-per-request-provider-token" }
```

`repo` also accepts a full URL (`https://github.com/owner/name`) or an SSH
URL, on any recognized provider (see [Providers](#providers)); bare
`owner/name` shorthand is assumed to be GitHub. `token` is optional and
overrides the configured credential _for the forge the request names_ —
useful for evaluating a private repo using the connecting user's own OAuth
token instead of a shared server token.

Response:

```json
{
  "eligible": true,
  "repo": { "provider": "github", "owner": "owner", "repo": "name" },
  "checks": {
    "language": { "passed": true, "primaryLanguage": "TypeScript", "reasons": [] },
    "size": { "passed": true, "totalLines": 12000, "totalFiles": 80, "reasons": [] },
    "history": { "passed": true, "commitCount": 210, "historyDays": 45, "...": "..." },
    "activeDevelopment": {
      "passed": true,
      "score": 0.93,
      "signals": {
        "daySpread": 1,
        "pushBulk": null,
        "messageQuality": 0.88,
        "contributorDiversity": 0.9
      },
      "distinctCommitDays": 30,
      "...": "..."
    }
  },
  "reasons": []
}
```

`reasons` (top-level and per-check) lists every requirement that failed, so
the caller can show the connecting user why they weren't eligible.
`activeDevelopment.signals` breaks the blended score into the four signals
behind it, so a near-miss is diagnosable; `null` means the forge could not
supply that signal, and it was excluded from the score rather than scored.

If the provider itself rate-limits a request (after the client's built-in
retries are exhausted), the endpoint returns 503 with a `Retry-After`
header and a `rateLimit` object (`remaining`, `resetAt`,
`retryAfterSeconds`, any of which may be absent if the provider didn't
report them) instead of a generic 502, so callers can back off
intelligently rather than retrying immediately. The error names the forge
that refused, which is not always the one a caller assumes.

GitHub answers 403 for both rate limiting and plain permission failures,
so the two are told apart by evidence (an exhausted quota, a `Retry-After`,
or GitHub naming a secondary rate limit in the message). A 403 that is
really "this token can't see that repo" is answered as a 502 straight
away, rather than being retried and then reported as a rate limit the
caller could wait out.

`POST /eligibility/check-batch`

```json
{ "repos": ["owner/name-1", "owner/name-2"], "token": "optional-per-request-provider-token" }
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

Cache keys are namespaced by the forge and by the rule set that produced
the verdict — the thresholds, the weights, the eligible-language list, and
the build (the `fingerprint` from `GET /rules`). A cached verdict is only
meaningful alongside the rules it was computed under, so retuning a
threshold takes effect immediately instead of after a TTL window of
answers from the old rules, and a rolling deploy sharing one Redis can't
have one build serve the other build's verdicts.

The cache backend is `memory` by default (per-process, lost on restart —
fine for a single instance). Set `CACHE_BACKEND=redis` and `REDIS_URL` to
share cached results across multiple instances of the service instead.

The cache is treated as an optimization, not a dependency: if the backend
is unreachable, a failed read degrades to a miss and a failed write is
dropped, so requests are still answered by computing the result. Those
failures are logged (`cache_unavailable`) and counted as `cacheErrors` in
`/metrics`, since otherwise a broken shared cache would show up only as a
mysteriously collapsed hit rate.

Concurrent cacheable requests for the same repo that all miss the cache
share a single in-flight computation rather than each cloning and
re-checking the repo independently. A `refresh` only shares work that
started after the request arrived: it means "the thing you rejected this
repo for is fixed, look again", and an evaluation already running may have
read the repo before the fix landed. Refreshes arriving together still
share one clone, so a client retrying in a loop costs one clone rather
than one per attempt.

Every evaluation actually performed (a cache hit doesn't count again) is
recorded to a SQLite audit trail — repo, timestamp, eligible, reasons — at
`HISTORY_DB_PATH` (default `./data/history.db`), so a past result stays
answerable later rather than only visible as a live snapshot.

`GET /admin/evaluations` reads that audit trail back over the API (gated by
the same `x-api-key` requirement as `/eligibility/*`, when `API_KEY` is
set). Results are most-recent-first, and the filters combine:
`?repo=owner/name` for one repo, `?eligible=true|false` for outcome,
`?since=`/`?until=` for an ISO-8601 time window, and `?limit=` to cap the
result count (default 50, max 200). A mistyped filter value is a 400
rather than an empty list, since "nothing matched" and "your query was
wrong" are different answers.

```bash
curl -s 'localhost:3000/admin/evaluations?eligible=false&since=2026-08-01T00:00:00Z' | jq
```

`GET /admin/evaluations/changes` answers the question the trail is usually
opened for after a threshold is retuned, or when a caller reports that a
repo which used to pass has started failing: which repos changed their
verdict, and which way. It reports the evaluations at which a verdict
flipped, newest first, with the direction, the reasons the new verdict came
with, and when the previous evaluation ran. Filterable by `?repo=`,
`?direction=became-eligible|became-ineligible`, `?since=`/`?until=`, and
`?limit=`. A repo's first evaluation inside the window is never a change —
there is nothing before it to differ from — so narrowing `since` hides
changes whose earlier verdict fell outside it.

```bash
curl -s 'localhost:3000/admin/evaluations/changes?direction=became-ineligible' | jq
```

## Providers

Repo references carry the provider they belong to, rather than every layer
assuming GitHub. Two lists matter, and they're deliberately different:

- **Recognized** (`src/providers/hosts.ts`): GitHub, GitLab, Bitbucket. A
  URL on any of these parses into a `{ provider, owner, repo }` reference.
- **Implemented** (`src/providers/registry.ts`): all three. The two lists
  agree today, and the seam between them stays: a forge added to the host
  table before its client exists is rejected with a 400 naming it, rather
  than with a parse error or a 502 that invites a pointless retry.

`GET /providers` answers both lists at runtime, assembled from those same
two files, along with an example reference per forge and which signals each
forge's API can contribute. It needs no API key — a client asking what it
may send has not sent anything yet.

GitLab projects can live under nested groups, so a GitLab reference's owner
may itself contain slashes (`acme/platform/widgets` is the project
`widgets` in the group `acme/platform`). URLs copied out of the GitLab UI
work as-is: parsing stops at the `/-/` segment GitLab uses to separate a
project path from a view of it. GitHub and Bitbucket keep the old rule,
where anything past the repo name is a page within the repo.

Credentials are per-forge: `GITHUB_TOKEN` (or a GitHub App installation),
`GITLAB_TOKEN`, and `BITBUCKET_TOKEN`. None is ever sent to another forge's
API. A per-request `token` is used for whichever provider the request
names.

Adding a forge means writing a `RepoProvider` — a commit-history summary
and a push-event summary, the only two things the eligibility checks need
from a forge — and registering it. Cloning, caching, the audit trail, and
the checks themselves need no change: clone URLs and token placeholder
usernames come from the host table, and cache keys and audit rows are
already provider-scoped, so `acme/widgets` on two forges stays two
distinct projects throughout.

The push-event method is best-effort by contract: a forge without such an
API reports `available: false`. A signal reported unavailable is left out
of the active-development score entirely, and the remaining weights are
renormalized over the signals that did have data — so a repo is judged on
the evidence that exists, and being hosted somewhere that reports less of
it is neither an advantage nor a penalty. The per-signal scores are in the
response, with `null` for one that could not be measured.

Bitbucket is the case that shape was built for: Bitbucket Cloud has no
repository events API, so those repos are always scored on three signals
rather than four.

## When a forge stops answering

Each forge has its own circuit breaker. After
`CIRCUIT_BREAKER_FAILURE_THRESHOLD` consecutive failures that look like the
forge itself being unavailable (5xx, timeouts, refused connections — not
404s, credential failures, or rate limiting), this instance stops calling
it for `CIRCUIT_BREAKER_OPEN_MS` and answers 503 immediately with a
`Retry-After` the breaker knows, then lets one request through to find out
whether the forge is back.

The alternative is worse than it sounds. Every call to a hard-down forge
walks the full retry schedule and pays `PROVIDER_REQUEST_TIMEOUT_MS` per
attempt, so what should be a fast failure becomes a request holding a
connection for most of a minute — and enough of those in flight and the
service stops answering about the two forges that are fine. Per-forge
breakers are what keeps one outage from becoming three.

Which failures count is each forge's own judgement, kept next to its retry
policy, because the same status means different things on different forges:
Bitbucket answers a revoked token with 401 where GitLab says 403, and
GitHub uses 403 for both rate limiting and plain permission failures.
Reading any of those as an outage would report a configuration mistake as
one. Rate limiting is excluded too — the quota is the caller's, not the
forge's health, and the service already answers with the reset time the
forge reported.

Breaker state is reported per forge in `/metrics`, `/metrics/prometheus`
(as a gauge, plus the consecutive-failure count that climbs before anything
is refused), and `/ready`. It deliberately does not make `/ready` fail: a
forge being down is not this instance's fault and not something another
instance would do better, so failing readiness over it would pull every
instance out of rotation and take down the forges that still work. `npm run
smoke` reports it too, after its evaluations rather than before them.

## Known limitations

- The commit-day histogram and push-event checks are heuristics, not proof:
  a determined bad actor could fake commit dates spread across many days.
  These checks are meant to catch the common "built locally, pushed once"
  case, not to be adversarially airtight.
- GitHub's push-event data is short-lived (~90 days / 300 events) and mixes
  in non-push activity, so `pushEvents.available` may be `true` with zero
  observed pushes for older or very active repos; the eligibility decision
  never depends on push-event data being present.
- Bitbucket reports no commit total anywhere and paginates commits with an
  opaque cursor, so its commit count comes from walking pages in sequence
  rather than from a header. The walk is capped at 500 commits, so a larger
  repo reports 500 with `truncated: true` — the safe direction, since the
  count is a minimum requirement and the cap sits far above it.
- Bitbucket Cloud has no repository events API, so the push-cadence signal
  is never available there. It is excluded from the score rather than
  guessed at.
- GitLab reports a project's exact commit count in a pagination header, but
  omits it for very large result sets. When that happens the count falls
  back to the bounded commit sample, which understates it — deliberately
  the safe direction, since the count is a minimum a repo shouldn't clear
  on a number the service could not verify.
- GitLab's events API needs `read_api` even for a public project, so a
  token without it makes the push-cadence signal unavailable rather than
  wrong. As with GitHub, an unavailable signal is excluded from the score
  rather than scored.
- The size/line-count check counts raw lines (including blank lines and
  comments) in files under the five eligible languages' extensions, and
  skips any single file over 2 MB — well above hand-written source, so what
  it excludes is generated/bundled output or committed data blobs. The
  number skipped is reported by the self-check CLI and in the per-check
  timing log.

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — request lifecycle,
  module map, extension seams, trust boundaries, and which failures the
  service survives on purpose.
- [`docs/operations.md`](docs/operations.md) — running it somewhere real:
  what to set before the first deploy, what the two probes mean, what a
  restart does, what to watch, and what the common failures look like.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — setup, the checks to run before
  pushing, commit-message style, and the invariants a change has to keep.
- [`CHANGELOG.md`](CHANGELOG.md) — what a caller or operator would notice
  changing between versions.
- [`docs/postman_collection.json`](docs/postman_collection.json) —
  importable request collection, generated from the OpenAPI spec.

## Testing

```bash
npm test        # unit tests (vitest) — no network access required
npm run typecheck   # type-checks src (build config) and test (test config)
```

`npm run typecheck` covers the test suite as well as `src`. Vitest strips
types without checking them, and the build config excludes `test/`, so
without the second pass a test could call a function with the wrong
arguments and still appear to pass.

### Load testing

```bash
npm run loadtest -- --repo owner/name --url http://localhost:3000 \
  --requests 200 --concurrency 20 [--api-key ...]
```

Drives a running instance and reports status distribution, latency
percentiles, and — read from `/metrics` before and after the run — how many
evaluations the service actually performed. Every request names the same
repo deliberately: the numbers worth looking at are how many requests the
rate limiter rejects (429s), and how far below the request count the
`evaluations` figure lands, which is the cache and in-flight coalescing
doing their job.
