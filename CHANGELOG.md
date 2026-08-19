# Changelog

All notable changes to this service are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions
follow [semantic versioning](https://semver.org/spec/v2.0.0.html).

Entries describe changes a _caller or operator_ would notice: endpoints,
request/response shapes, configuration, defaults, and behaviour under
failure. Internal refactors, test-only work, and tooling changes belong in
the commit log, not here.

This file started partway through the project's life, so the entries below
were reconstructed from the commit history rather than written as the work
landed. Version `0.1.0` has never been tagged — everything to date is
unreleased.

## [Unreleased]

### Added

- `POST /eligibility/check` — evaluate one repo against four checks:
  primary language, size, commit-history span, and whether development
  looks organic rather than bulk-pushed.
- `POST /eligibility/check-batch` — up to 20 repos per request, evaluated
  with bounded concurrency. Always answers 200; per-entry failures are
  reported inside the response.
- `GET /admin/evaluations` — read-only view of the SQLite audit trail,
  filterable by repo and capped by `limit` (default 50, max 200).
- `GET /health` (liveness), `GET /ready` (readiness: reports 503 when the
  cache backend or audit-trail database is unusable), `GET /metrics` (JSON
  counters), `GET /metrics/prometheus` (the same counters in Prometheus's
  text exposition format), and `GET /openapi.json` (the spec).
- Optional API-key auth on `/eligibility` and `/admin` via `API_KEY`, and
  rate limiting via `RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX`.
- Pluggable result cache via `CACHE_BACKEND` (`memory` or `redis`), so
  multiple instances can share results instead of each starting cold.
- SQLite audit trail of every evaluation performed, at `HISTORY_DB_PATH`.
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
- Developer tooling: a local self-check CLI (`npm run stats`), a load-test
  tool for the rate limiter and cache under concurrency
  (`npm run loadtest`), and a Postman/Insomnia collection generated from
  the OpenAPI spec (`npm run collection`).

### Changed

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
