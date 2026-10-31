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

## [Unreleased]

### Fixed

- The error log bounds the request path it echoes, the same way the access
  log and the 404 body already do - previously a long caller-chosen URL
  that triggered a 500 was logged in full, so the same log-budget cost the
  access-log fix closed off on the happy path was still open on the error
  one.
- The shared truncation helper behind that bound, the 404 body, and a
  provider's error message no longer splits a character outside the Basic
  Multilingual Plane (most emoji, among others) in half when the cutoff
  lands between its two UTF-16 code units - previously the leftover lone
  surrogate showed up as a literal replacement character in the log line
  or response instead of the character it was part of.
- `GET /admin/evaluations`, `/admin/evaluations/summary`, and
  `/admin/evaluations/changes` now answer 400 when `since` is after
  `until`, the same way an unparseable timestamp already does - previously
  an inverted window ran as a query that matches nothing, which reads as
  "no evaluations happened" rather than as the caller mistake it actually
  is.
- The source-size scan behind the history check no longer counts a
  minified `.mjs` or `.cjs` bundle against a repo's size, the same way a
  minified `.js` or `.css` file is already excluded - previously a
  vendored ESM/CJS bundle could push an otherwise-small repo over the
  size limit for a file nobody wrote by hand.
- The source scan now recognizes `.mts` and `.cts` files as TypeScript -
  previously a repo written against Node's explicit ESM/CJS TypeScript
  extensions had those files silently excluded from its line/file count
  and primary-language detection, understating its size and sometimes its
  primary language.
- The source scan now excludes `.tox` and `.eggs` directories, the same
  way `venv`/`.venv`/`node_modules` already are - previously a Python
  repo's per-environment tox installs or downloaded egg sources could be
  counted as first-party lines, inflating its size and occasionally its
  primary-language verdict.
- The source scan now excludes the `.yarn` directory, the same way
  `node_modules` already is - previously a repo using Yarn Berry could
  have its unplugged/cached dependencies or bundled release script
  counted as first-party JavaScript, inflating its size and occasionally
  its primary-language verdict.

### Changed

- Commit-message quality now recognizes generic placeholders like
  `commit-12`, `commit_12`, and `day-3`, not only `commit 12` and `day 3`
  - previously a hyphen- or underscore-separated counter slipped past the
    generic-message check and was scored as real, descriptive history.

## [1.3.0] - 2026-08-31

Verdicts that stay true to the rules that produced them, a limit that
counts the work it is limiting, and an outage that costs one forge rather
than three.

### Added

- `GET /rules` - the bar a repo is measured against: the size, history,
  and active-development thresholds, the per-signal weights behind the
  blended score, and which languages count. Previously the only way to
  learn a threshold was to be rejected by it, one check at a time, and the
  alternative - an integrator writing the numbers into their own docs - is
  a copy that goes stale the first time one is retuned. Served off the
  same values the checks read, so it cannot describe a bar the service
  doesn't enforce. Unauthenticated and outside the rate limit, like
  `/providers`.
- A **circuit breaker per forge**. After
  `CIRCUIT_BREAKER_FAILURE_THRESHOLD` consecutive failures that look like
  the forge being unavailable, this instance stops calling it for
  `CIRCUIT_BREAKER_OPEN_MS` and answers 503 immediately with a
  `Retry-After` it can actually justify, then probes with a single request.
  Every call to a hard-down forge otherwise walked the full retry schedule
  at `PROVIDER_REQUEST_TIMEOUT_MS` per attempt, so one forge's outage could
  occupy enough connections to stop the service answering about the other
  two. Which failures count is per-forge: a 404, a rejected credential, and
  rate limiting are all answers, and an upstream that answers is up.
- `CIRCUIT_BREAKER_FAILURE_THRESHOLD` and `CIRCUIT_BREAKER_OPEN_MS`.
  Defaults: 5 failures, 30000ms.
- `GET /admin/evaluations/changes` - where a repo's verdict flipped,
  newest first, with the direction, the reasons the new verdict came with,
  and when the previous evaluation ran. Filterable by repo, direction, and
  window. The row list answers what happened and the summary answers how
  often; this answers which repos changed their mind, which previously
  meant pulling every row and diffing them by hand.
- Circuit state per forge in `/metrics`, `/metrics/prometheus`, and
  `/ready`. Reported for every forge including the healthy ones, since a
  series that only appears when something breaks cannot be alerted on, and
  its absence is indistinguishable from a failed scrape. It deliberately
  does not fail `/ready`: a forge being down is not this instance's fault,
  and failing readiness over it would pull every instance out of rotation
  and take down the forges that still work.
- `npm run doctor` reviews the new settings, and warns when
  `RATE_LIMIT_MAX` is below the batch cap - under which a full-size batch
  is refused every time, however long the caller waits.
- `npm run smoke` reports which rule set an instance is enforcing and
  whether it has given up on any forge.

### Changed

- **The `/eligibility` rate limit is now counted in repos, not requests.**
  A batch spends one unit per repo it lists. Every request cost one unit
  before, so a caller sending batches of 20 instead of single checks got
  400 clones a minute out of an allowance that reads as 20 - and an
  operator setting `RATE_LIMIT_MAX` was sizing a limit that meant twenty
  times less than they thought. A single check is unaffected.
- A 503 that carries a wait now reports it as `retryAfterSeconds`
  separately from `rateLimit`, so a circuit-breaker cooldown isn't
  described as an exhausted quota.

### Fixed

- **A cached verdict no longer outlives the rules that produced it.**
  Cache keys carried the repo and forge but nothing about the thresholds,
  so narrowing `ELIGIBLE_LANGUAGES` or raising a threshold left every
  recently-checked repo being answered from the old rules for a full
  `CACHE_TTL_MS` - the setting reads as having taken effect and hasn't.
  Worse, a rolling deploy against one Redis had whichever build warmed a
  key decide the answer both served, which doesn't clear when the TTL
  expires. Keys are now namespaced by a fingerprint of the thresholds,
  weights, language list, and build; a release starts with a cold cache as
  a result.
- **A `refresh` is no longer answered by work that started before the
  caller asked for it.** It joined whatever evaluation of that repo was
  already running, which may have cloned the repo or read its commit
  history before the caller's fix landed - so the recheck reported the
  problem still there, and refreshing again joined the same stale
  computation. Refreshes arriving together still share one clone.

## [1.2.0] - 2026-08-24

Bitbucket support, and the scoring bug it uncovered.

The provider seam now has three implementations behind it. The third one is
the one that tested it: GitLab is shaped like GitHub, and Bitbucket is not

- no commit total anywhere, cursor pagination, and no repository events API
  at all. None of that reached past its client and adapter.

### Added

- Bitbucket repos are now evaluated rather than refused. A `bitbucket.org`
  URL or ssh reference is checked the same way a GitHub or GitLab one is,
  against the same thresholds.
- `BITBUCKET_TOKEN` - a Bitbucket repository, project, or workspace access
  token (or an OAuth token), used for API calls and for cloning private
  repos; `repository:read` covers both. Per-forge like the other two:
  neither of the others is ever sent to Bitbucket, and this one is never
  sent to them. Bitbucket's older app passwords are not supported, since
  this is sent as a bearer token.
- `GET /providers` - which forges this build recognizes, which it can
  evaluate, an example reference for each, and which signals each forge's
  API contributes. Assembled from the same tables the request path uses, so
  it cannot claim support the service does not have. Unauthenticated and
  not rate-limited: a client asking what it may send has not sent anything
  yet.
- `activeDevelopment.signals` in an eligibility result - the four signals
  behind the blended score, so a near-miss is diagnosable. A `null` means
  the forge could not supply that signal.
- `npm run doctor` warns when `BITBUCKET_TOKEN` is unset, and its provider
  summary is now keyed by every forge - it previously reported "no
  credential" for any forge added after it was written, whatever the
  environment held.
- `npm run smoke` checks a real public Bitbucket project by default, and
  opens by asking the instance which forges it evaluates. The Bitbucket
  path is the most expensive one to get wrong: its API host
  (`api.bitbucket.org`) differs from its clone host, so a deployment can
  clone from Bitbucket and still fail every API call.

### Changed

- **A signal the forge could not supply no longer counts as a passing
  signal.** The active-development score blends four signals, and an
  unavailable one was scored a full 1.0 - which handed the repo that
  signal's entire weight for free against a fixed threshold. An absent
  signal is now excluded and the remaining weights are renormalized over
  the signals that had data. A repo that only cleared the bar on that free
  credit is now rejected. This was always wrong on GitHub, whose Events API
  only remembers recent activity; Bitbucket, which has no events API at
  all, would have made it permanent for every repo hosted there.
- A rate-limit refusal (503) now names the forge that actually refused.
  Every one of them said "GitHub API rate limit hit", including refusals
  about GitLab projects, which sent callers to check a quota that had
  plenty of budget left.
- The OpenAPI description no longer says evaluation is implemented "for
  github, gitlab, bitbucket only" now that there is no gap for "only" to
  describe, and the per-request `token` field is documented as overriding
  the credential for whichever forge the request names, rather than
  `GITHUB_TOKEN`.

### Fixed

- The not-supported-provider error threw a `TypeError` while being
  constructed if handed a forge the host table does not name, turning what
  should be a clean 400 into a 502. Unreachable today, but it is the error
  path, which is the worst place for one.

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
