# Changelog

All notable changes to this service are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions
follow [semantic versioning](https://semver.org/spec/v2.0.0.html).

Entries describe changes a _caller or operator_ would notice: endpoints,
request/response shapes, configuration, defaults, and behaviour under
failure. Internal refactors, test-only work, and tooling changes belong in
the commit log, not here.

This file started partway through the project's life, so the 1.0.0 entries
below were reconstructed from the commit history rather than written as the
work landed. Everything after that release is written as it lands.

## [1.1.0] - 2026-08-23

GitLab support. The provider seam shipped in 1.0.0 with one implementation
behind it; this is the second, which is what turns the abstraction from a
claim into a tested one.

### Added

- GitLab repos are now evaluated rather than refused. A `gitlab.com` URL,
  ssh reference, or `/-/`-suffixed URL copied out of the GitLab UI is
  checked the same way a GitHub one is, against the same thresholds.
- `GITLAB_TOKEN` — GitLab personal or project access token, used for API
  calls and for cloning private projects (`read_api`, plus
  `read_repository` for private clones). Per-forge on purpose: neither
  token is ever sent to the other forge's API. A per-request `token` still
  applies to whichever provider the request names.
- `PROVIDER_REQUEST_TIMEOUT_MS` (default 10000) — ceiling on a single
  outbound provider API call, so one unresponsive upstream can't hold a
  request open indefinitely.
- `/metrics` reports `eligibilityByProvider`, and `/metrics/prometheus`
  exports `account_updater_eligibility_checks_by_provider_total` labelled
  by provider and outcome — with two forges, an aggregate pass rate can't
  say whether the service changed or one forge's traffic did.
- `npm run doctor` opens with which forges this build can evaluate and
  whether each has a credential, and warns when `GITLAB_TOKEN` is unset. A
  warning rather than a blocker: a deployment can legitimately never see a
  GitLab repo.
- `npm run smoke` checks a GitLab project by default alongside the GitHub
  ones, since the offline suites cannot catch a deployment with no route to
  gitlab.com or an expired GitLab token.

### Changed

- A rate-limit refusal now reports the remaining quota and reset time from
  either forge. GitLab follows the IETF RateLimit-Headers draft and sends
  those values unprefixed, so previously a GitLab 429 reached the caller
  without the detail that makes a 503 actionable.
- Bitbucket is now the only recognized-but-unimplemented forge, and its
  400 names both forges that do work.

### Fixed

- A GitLab URL naming a project inside a group
  (`gitlab.com/acme/platform/widgets`) was read with GitHub's rule — owner
  is the first path segment — and evaluated the group `acme/platform`
  instead of the project. Nested namespaces are now part of the reference,
  validated segment by segment, and capped at GitLab's own depth limit of 20.
- A blank `Retry-After` header from an upstream was read as "retry
  immediately" instead of as absent, defeating the backoff it was meant to
  pace.

### Security

- The default credential is now resolved from the ref's forge instead of
  being applied before the forge is known. The HTTP layer defaulted every
  request to `GITHUB_TOKEN`, which was harmless while every reference was
  a GitHub one — and would have sent a GitHub token to `gitlab.com`, as an
  API header and inside the clone URL, the first time a GitLab repo was
  evaluated. A forge with no configured credential is now called
  unauthenticated rather than with another forge's secret.

## [1.0.0] - 2026-08-20

First tagged release. The service has been feature-complete for its
purpose for a while; this marks the point where the operational side
caught up — draining shutdown, audit-trail retention, a pre-deploy
configuration review, and a post-deploy smoke test against a running
instance — and the API stopped changing shape under callers.

Thresholds and weights in `src/eligibility/thresholds.ts` ship as they
are: they were calibrated by hand rather than against a labelled corpus,
so they are a considered starting point, not a tuned one. Changing them
changes verdicts, which is why they are a documented, single-file
decision rather than something scattered across the checks.

### Added

- `POST /eligibility/check` — evaluate one repo against four checks:
  primary language, size, commit-history span, and whether development
  looks organic rather than bulk-pushed.
- `POST /eligibility/check-batch` — up to 20 repos per request, evaluated
  with bounded concurrency. Always answers 200; per-entry failures are
  reported inside the response.
- `GET /admin/evaluations` — read-only view of the SQLite audit trail,
  with combinable filters: `repo`, `eligible`, a `since`/`until` time
  window, and `limit` (default 50, max 200).
- `GET /admin/evaluations/summary` — counts over the audit trail instead
  of the rows themselves: totals, pass rate, distinct repos, and the most
  common failure reasons, grouped with per-repo specifics replaced
  (`Only N lines of first-party source found (need at least N).`) and one
  verbatim example each. Same `repo`/`since`/`until` filters as the list,
  plus `topReasons`.
- `GET /health` (liveness), `GET /ready` (readiness: reports 503 when the
  cache backend or audit-trail database is unusable), `GET /metrics` (JSON
  counters), `GET /metrics/prometheus` (the same counters in Prometheus's
  text exposition format), and `GET /openapi.json` (the spec).
- Optional API-key auth on `/eligibility` and `/admin` via `API_KEY`, and
  rate limiting via `RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX`.
- `refresh: true` on `POST /eligibility/check` and
  `POST /eligibility/check-batch`, which recomputes instead of answering
  from cache and stores the fresh result — for rechecking a repo whose
  problem was just fixed, rather than waiting out `CACHE_TTL_MS`. Counted
  as `cacheRefreshes` in `/metrics`, apart from hits and misses, because
  it always clones and calls the provider API.
- Pluggable result cache via `CACHE_BACKEND` (`memory` or `redis`), so
  multiple instances can share results instead of each starting cold.
- SQLite audit trail of every evaluation performed, at `HISTORY_DB_PATH`,
  kept to `HISTORY_RETENTION_DAYS` (default 90) by a sweep that runs at
  startup and every `HISTORY_PRUNE_INTERVAL_MS` after. Set the retention to
  0 to keep rows forever.
- Authentication as a GitHub App installation
  (`GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` / `GITHUB_APP_INSTALLATION_ID`)
  alongside `GITHUB_TOKEN`, for higher rate limits without a shared PAT.
- Configurable eligible-language list via `ELIGIBLE_LANGUAGES`; an
  unrecognized name fails fast at startup.
- Per-stage timing of clone/scan, commit history, and push events, exposed
  through `/metrics` so a slow check is diagnosable by stage.
- A provider seam (`RepoProvider`) plus a registry, so a second forge is an
  implementation and one registry entry rather than a rewrite. GitLab and
  Bitbucket references parse and are answered with a precise "not supported
  yet" 400.
- Docker image with a healthcheck, `docker-compose.yml`, and graceful
  shutdown on SIGTERM/SIGINT.
- `SHUTDOWN_DRAIN_MS` / `SHUTDOWN_GRACE_MS` to pace shutdown: how long to
  keep serving while reporting not-ready, and the hard deadline for the
  whole shutdown.
- `npm run smoke`, a post-deploy check that drives a running instance end
  to end over HTTP against real public repos — liveness, readiness, spec,
  an eligibility check per repo, a rejected reference, and the audit trail
  recording the checks just made. Exits non-zero if any of them fail.
- `npm run doctor`, a pre-deploy review of the configuration the current
  environment would start the service with: missing API key or GitHub
  credential (critical, exits non-zero), a per-process cache behind a load
  balancer, an audit trail under `/tmp`, retention disabled, no shutdown
  drain window, or a rate limit that allows more clones than a host will
  like. The same review runs at startup and logs anything above
  informational.
- Developer tooling: a local self-check CLI (`npm run stats`), a load-test
  tool for the rate limiter and cache under concurrency
  (`npm run loadtest`), and a Postman/Insomnia collection generated from
  the OpenAPI spec (`npm run collection`).

### Changed

- Every rate-limited response carries `X-RateLimit-Limit`,
  `X-RateLimit-Remaining`, and `X-RateLimit-Reset` (unix seconds), not just
  the 429, so a caller can pace itself before it is refused.
- `/admin/*` is rate-limited on the same settings as `/eligibility/*`, with
  its own separate budget.
- The active-development check is a weighted blend of four signals (day
  spread, push-event bulk delivery, commit-message variety, contributor
  diversity) scored against one threshold, rather than four independent
  pass/fail rules — a repo that is mildly off on one signal is no longer
  rejected as hard as one that is bad on all of them.
- GitHub rate limiting is answered as 503 with `Retry-After` and rate-limit
  details, distinct from a 502 for other upstream failures.
- Repo references are provider-scoped throughout, including cache keys and
  audit-trail rows, so the same `owner/name` on two forges can't collide.

### Fixed

- An unmatched route answers 404 as JSON, like every other error, instead
  of falling through to Express's default HTML error page - previously a
  typo'd path was the one response a client parsing `error` out of a JSON
  body couldn't read. The body names the method and path and points at
  `GET /openapi.json`.
- The access log bounds the request path it echoes, so long URLs can't be
  used to run up a log bill.
- Shutdown now drains before it closes the listener. `GET /ready` reports
  `draining: true` and 503 as soon as SIGTERM arrives, and the listener
  stays open for `SHUTDOWN_DRAIN_MS` so a load balancer can take the
  instance out of rotation first — previously the socket closed
  immediately and every request routed in that gap became a connection
  error. `GET /health` stays 200 (with `status: "draining"`) so the
  platform doesn't restart a process that is deliberately going away, and
  idle keep-alive connections are dropped rather than holding shutdown
  open until the deadline.
- Repo-URL parsing no longer accepts crafted URLs (embedded userinfo,
  lookalike hosts, non-https schemes) that could steer the outbound clone
  at an internal address.
- Unparseable commit dates no longer pass the history check as if they were
  valid timestamps.
- The rate limiter's window map and the in-memory cache's entry map no
  longer grow without bound.
- The source scan bounds its memory use on repos containing very large
  files.
- An unreachable cache backend degrades to a miss instead of failing the
  request, and is counted (`cacheErrors`) and reported by `GET /ready`.
- Clone failures are scrubbed of any token before the error reaches a log
  line or response.
- A GitHub 403 that is a permissions failure (a token without access to a
  private repo, or one not SSO-authorized for an organization) is no
  longer reported as rate limiting: it answers 502 immediately instead of
  503 "try again later" after three pointless retries that spent more of
  the caller's quota.
- The rate limiter no longer buckets by the raw `x-api-key` header, which
  let any caller escape the limit by sending a different value on each
  request. Only a header matching the configured `API_KEY` selects a
  per-key budget; everything else is limited per remote IP.
