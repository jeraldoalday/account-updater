# Architecture

This document explains how a request moves through the service, why the
pieces are split the way they are, and where to make a change. It's a map,
not a spec: exact numbers live in `src/eligibility/thresholds.ts`, and the
API surface lives in `src/openapi.ts` (served at `GET /openapi.json`), both
of which are kept honest by tests rather than restated here.

## The shape of the problem

The service answers one question: _does this repo look like a real,
actively-developed first-party project, or like a scaffold or a codebase
that was built locally and pushed all at once?_

That question can't be answered from a repo's current file tree alone (a
generated scaffold has plenty of files) or from its commit history alone (a
repo with hundreds of commits can still be 200 lines of YAML). So the
service gathers two independent views — the file tree and the commit
history — and runs four checks across them.

## Request lifecycle

```
POST /eligibility/check
  │
  ├─ requestId ─── attaches x-request-id, so every log line for this
  │                request is greppable together
  ├─ express.json()
  ├─ requestLogger ─ one structured JSON line per request on completion
  ├─ rateLimit ──── per API key, or per IP when no key is configured
  ├─ apiKeyAuth ─── no-op unless API_KEY is set
  │
  └─ eligibility.route
       │
       ├─ parseRepoRef()  "owner/name" | https URL | SSH shorthand → RepoRef
       │                  (also the SSRF guard — see "Trust boundaries")
       │
       └─ evaluateEligibility(ref, token, { cacheable })
            │
            ├─ cache read ──── hit? return it (never for a caller-supplied token)
            ├─ in-flight map ─ another request already computing this repo? join it
            │
            └─ computeEligibility()
                 │  three stages, concurrent, each individually timed
                 ├─ clone + scan ──── git clone --depth 1 → count lines/files by language
                 ├─ commit history ── provider API: exact count, first/last date, sample
                 ├─ push events ───── provider API: recent push cadence (best-effort)
                 │
                 ├─ checks: language, size, history, activeDevelopment
                 ├─ metrics + timing log
                 └─ audit-trail write (best-effort)
```

`/eligibility/check-batch` is the same path, fanned out over up to 20 repos
with a concurrency cap of 3, and it always answers 200: per-entry failures
are reported inside the response, because one bad repo in a batch shouldn't
fail the other nineteen.

## Module map

| Area             | Path                                             | Responsibility                                             |
| ---------------- | ------------------------------------------------ | ---------------------------------------------------------- |
| HTTP wiring      | `src/app.ts`, `src/routes/`                      | Route registration, request/response shapes                |
| Middleware       | `src/middleware/`                                | Request ID, logging, rate limit, API key, error handling   |
| Repo references  | `src/utils/repoUrl.ts`, `src/providers/hosts.ts` | Parse and validate a repo reference; build clone URLs      |
| Provider seam    | `src/providers/`                                 | What the checks need from a forge, and who implements it   |
| Clone + scan     | `src/clone/`, `src/analysis/sourceScan.ts`       | Temp shallow clone; per-language line/file counts          |
| History analysis | `src/analysis/`                                  | Turn a commit sample into day/author/message distributions |
| Checks           | `src/eligibility/`                               | The four checks and the thresholds they compare against    |
| Cache            | `src/cache/`                                     | Pluggable result cache (in-memory or Redis)                |
| Audit trail      | `src/history/`                                   | SQLite record of every evaluation performed                |
| Observability    | `src/metrics/`, `src/health/`                    | Counters, Prometheus rendering, readiness probe            |
| Docs             | `src/openapi.ts`, `src/docs/`                    | The spec, and the collection generated from it             |
| CLI tools        | `src/cli/`                                       | Local self-check, load test, collection generator          |

## The four checks

Three are threshold comparisons; the fourth is the interesting one.

- **language** — the repo's primary language (by lines, after excluding
  vendor/build/generated paths) must be one of the eligible languages.
- **size** — enough lines and files in that language to be a real project.
- **history** — enough commits, spread over a long enough window between
  the first and last commit.
- **activeDevelopment** — whether the history looks organic rather than
  bulk-pushed.

The last one used to be a set of independent pass/fail rules, which made it
brittle: a legitimate repo that was mildly off on one signal was rejected
exactly as hard as one that was bad on every signal. It is now a weighted
blend of four signals — commits spread across many days with no single day
dominating; no single push event delivering most of the commits; varied,
descriptive commit messages rather than templated ones; and some
contributor diversity, scored leniently because a single-maintainer repo is
both common and legitimate — that has to clear one score threshold.

Push-event data is a _best-effort_ signal by contract: GitHub only retains
about 90 days of events, so a provider that has nothing to report must say
`available: false` and have that treated as neutral, never as a failure.

## Extension seams

**Adding a forge.** `RepoProvider` (`src/providers/provider.ts`) is
deliberately narrow: two methods about commit-history shape and push
cadence. Nothing about pagination, auth, or event-type names leaks into the
checks. Implement it and add one entry to the registry in
`src/providers/registry.ts`; the file-tree half needs nothing, because it's
a plain `git clone` against a URL built from the provider's host entry.

Note the split between _naming_ a forge and _supporting_ one: `hosts.ts`
knows GitLab and Bitbucket so their URLs parse into a precise "not
supported yet" 400, rather than a confusing parse error or a 502 that
invites the caller to retry something that can never succeed.

**Adding a cache backend.** Implement `Cache<V>` (`src/cache/cache.ts`) and
add it to `createCache()`. `ping()` exists so `GET /ready` can report on the
backend; the request path never depends on the cache being up.

**Changing thresholds.** All in `src/eligibility/thresholds.ts`, including
the weights for the blended score. They are read once at startup.

## Trust boundaries

Everything a caller sends is untrusted, and two things in this service take
that seriously in particular.

**Clone targets.** `parseRepoRef()` validates owner and repo against
GitHub's naming rules (the strictest of the supported forges) and resolves
the host against a fixed table of known code hosts. Clone URLs are then
_rebuilt_ from the provider's canonical host rather than passed through, so
a crafted URL — embedded userinfo, an unknown host, a non-https scheme —
can't steer the service's outbound `git clone` at an internal address. The
temp clone is always removed afterwards, success or failure, and tokens are
scrubbed from any git error before it can reach a log line or response.

**Caller-supplied tokens.** A per-request `token` may grant access to a
private repo that other callers don't have, so a result computed with one is
never cached: `cacheable` is false for exactly that case. The generated
Postman collection leaves `token` out of its example bodies for the same
reason.

## Failure modes, on purpose

Several dependencies are optional by design, and it's worth being explicit
about which failures are survivable:

- **Cache down** → reads degrade to a miss, writes are dropped; the request
  still succeeds. Counted as `cacheErrors` and reported by `GET /ready`.
- **Audit-trail write fails** → logged and swallowed; a caller's check
  doesn't fail because a record couldn't be filed.
- **Push-events API unavailable** → treated as a neutral, missing signal.
- **GitHub rate limit** → 503 with a `Retry-After` header and the rate-limit
  details, after retries with backoff are exhausted. Distinct from a 502,
  which means the upstream broke in some other way.

That's also the reason `GET /ready` exists at all: because so little takes
the service _down_, a degraded instance would otherwise look perfectly
healthy while paying full clone and API cost on every request.

## State

Two stores, both optional-ish:

- **Result cache** — in-memory by default, Redis when `CACHE_BACKEND=redis`
  so multiple instances share results. Concurrent misses for the same repo
  are coalesced in-process so a burst doesn't clone the same repo N times.
- **SQLite audit trail** — one row per evaluation _performed_ (a cache hit
  writes nothing), readable through `GET /admin/evaluations`. Schema
  changes are applied as in-place migrations at open time, so an existing
  deployment's history isn't dropped.

Everything else — metrics, rate-limit windows — is per-process and
deliberately so; a multi-instance deployment scrapes each instance rather
than sharing a counter store.
