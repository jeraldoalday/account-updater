# Operations

How to run this service somewhere real: what to set before the first
deploy, what the probes mean, what happens during a restart, and what to
look at when something is wrong.

The companion documents are [`architecture.md`](architecture.md) (how a
request moves through the code) and `GET /openapi.json` (the API surface).
Configuration is listed in `.env.example`, which is the authority on the
variables themselves — this document covers the decisions behind them
rather than repeating the list.

## Before the first deploy

Run the configuration review against the environment the service will
actually start in:

```bash
npm run doctor
```

It exits non-zero on a critical finding, so it can gate a release
pipeline. The two criticals are the ones that matter most and are the
easiest to forget:

- **No `API_KEY`.** `/eligibility` clones arbitrary repos on demand and
  `/admin` reads the audit trail. Without a key, anyone who can reach the
  instance can do both. Either set one, or be certain the network in front
  of it is the boundary.
- **No GitHub credential.** Unauthenticated GitHub API calls get 60
  requests an hour for the whole instance, shared across every repo it
  checks. The service will work in a demo and fail under any real use.
  Set `GITHUB_TOKEN`, or a GitHub App installation for a higher shared
  limit.

`doctor` also warns — rather than blocks — on a missing `GITLAB_TOKEN` or
`BITBUCKET_TOKEN`, and opens with which forges this build can evaluate and
whether each has a credential. Those two are warnings because a deployment
can legitimately never see a repo on either forge; if it does see one, the
failure is the same shape as the GitHub case: throttled requests, and
private repos invisible.

Warnings are judgement calls rather than mistakes — a per-process cache
and a relative database path are both reasonable on a single instance —
so they are printed without failing the run. The same review runs at
startup and logs anything above informational, which is what catches an
instance that was deployed without ever running `doctor`.

## After a deploy

```bash
npm run smoke -- --url https://your-instance
```

The test suite runs entirely against fakes, by design: no network, no
clone, no GitHub. That is what makes it fast, and it is also why a green
suite says nothing about whether _this deployment_ has a `git` binary,
outbound network access, a writable database, or a token that hasn't
expired. The smoke test drives the running instance over HTTP against
real public repos and checks exactly those things.

It asserts the shape of each answer, never the verdict. Whether a given
public repo is eligible today depends on GitHub and on the thresholds, and
a smoke test that asserts a verdict starts failing for reasons that have
nothing to do with the deployment's health.

## The two probes

They answer different questions and should be wired to different things.

| Probe     | Question               | Wire it to                     |
| --------- | ---------------------- | ------------------------------ |
| `/health` | Is this process alive? | Liveness / restart policy      |
| `/ready`  | Should it get traffic? | Load balancer / readiness gate |

`/health` is a 200 as long as the process is running, **including while it
is shutting down** (where it reports `status: "draining"`). A deliberate
shutdown must not be counted as a crash and restarted mid-drain.

`/ready` answers 503 when the cache backend or the audit-trail database is
unusable, or when the process has begun shutting down (`draining: true`).
Both dependencies are deliberately non-fatal per request — a cache error
degrades to a miss, an audit-trail write failure is swallowed — so this
probe is the only thing that will ever tell you they are broken. An
instance pointing at an unreachable Redis looks perfectly healthy while
paying full clone and API cost on every single request.

## Restarts and deploys

On `SIGTERM` (or `SIGINT`), the process:

1. flips readiness to draining, so `/ready` starts answering 503;
2. keeps serving for `SHUTDOWN_DRAIN_MS` (default 5s) — this is the window
   in which the load balancer notices and stops routing here;
3. closes the listener, letting in-flight requests finish while idle
   keep-alive sockets are dropped;
4. releases the retention timer, the Redis connection, and the SQLite
   handle;
5. exits.

`SHUTDOWN_GRACE_MS` (default 20s) is the hard deadline for all of it;
past that, remaining connections are cut and the process exits non-zero.
A second signal exits immediately.

**Set the drain window to at least one readiness-probe interval.** If it
is shorter, the listener closes before the load balancer has re-probed,
and every request routed in that gap is a connection error — which is the
exact failure this sequence exists to avoid. `npm run doctor` flags a
drain window of 0.

An eligibility check can legitimately take tens of seconds on a large
repo, so keep the platform's own termination grace period comfortably
above `SHUTDOWN_GRACE_MS`, or it will `SIGKILL` a shutdown that was going
to finish.

## Running more than one instance

Two things are per-process and need attention when you scale out:

- **The cache.** `CACHE_BACKEND=memory` means each instance caches on its
  own and every new instance starts cold. Set `CACHE_BACKEND=redis` with
  `REDIS_URL` so they share results.
- **The rate limiter.** It is in-memory, so the effective limit is
  `RATE_LIMIT_MAX` _per instance_. Behind a load balancer, budget
  accordingly, or enforce the real limit at the proxy.

The audit trail is a SQLite file, so each instance writes its own unless
they share a volume. `GET /admin/evaluations` therefore shows the
evaluations that instance performed, not the fleet's.

## The audit trail

Every evaluation actually performed writes one row (a cache hit doesn't).
Rows older than `HISTORY_RETENTION_DAYS` (default 90) are deleted by a
sweep at startup and every `HISTORY_PRUNE_INTERVAL_MS` after.

Setting retention to 0 keeps everything, which is a reasonable choice only
if something else is shipping the rows elsewhere and watching the disk —
otherwise the file grows for as long as the process runs, and the endpoint
whose writes to it are best-effort is the one that goes down when the disk
fills.

Point `HISTORY_DB_PATH` at a persistent volume. The default is relative to
the working directory, and a path under `/tmp` will be cleared out from
under you; `doctor` flags both.

## What to watch

`GET /metrics` (JSON) and `GET /metrics/prometheus` (text exposition
format) expose the same counters. The ones worth an alert:

- **`cacheErrors` climbing.** The shared cache backend is failing. Requests
  still succeed, which is why nothing else will tell you: the hit rate
  collapses and every request pays full clone and API cost.
- **`cacheHits` collapsing without `cacheErrors` climbing.** Either the TTL
  is too short for the traffic, or callers are sending `refresh: true` —
  check `cacheRefreshes`, which is counted separately for exactly this
  reason.
- **`requestsByStatusClass` 5xx.** 502 is an upstream failure (clone or
  API); 503 is provider rate limiting, a circuit breaker open for that
  forge, or a readiness failure - the body tells you which.
- **A forge's circuit sitting `open` in `providerCircuits`** (`/metrics`)
  or `account_updater_provider_circuit_state` (`/metrics/prometheus`).
  That forge has failed `CIRCUIT_BREAKER_FAILURE_THRESHOLD` times in a row
  and this instance has stopped calling it for `CIRCUIT_BREAKER_OPEN_MS`.
  Reported for every forge, including the healthy ones, so its absence
  from a scrape isn't mistaken for "nothing is open" - check `lastError` on
  the snapshot for what tripped it.
- **`stageDurations`.** A slow check is diagnosable by stage —
  `cloneAndScan` vs `commitHistory` vs `pushEvents` — because those three
  run concurrently and a total duration alone can't separate them.

Every response carries `x-request-id` (reusing an incoming one), and every
log line is a single JSON object carrying it, so a report from a caller
joins to the access log line and any error line from the same request.

## When something is wrong

**Every check returns 503 with rate-limit details.** A provider credential
has run out of quota. The error names which forge — read it before going
to look at a quota, because with three forges implemented the one that
refused is not always the one being assumed. Then check which credential
is in use for that forge: a per-request `token` beats the configured one
(`GITHUB_TOKEN` / `GITLAB_TOKEN` / `BITBUCKET_TOKEN`), and on GitHub the
configured token beats the App installation. An instance with no GitHub
credential at all is on 60 requests an hour — `doctor` calls that one out
as critical.

**Every check against one forge returns 503 immediately, with
`retryAfterSeconds` but no `rateLimit`.** That forge's circuit breaker is
open, not its quota — the request was refused without ever calling the
forge. Check `providerCircuits` in `/metrics` for `lastError` on that
forge's breaker to see what tripped it, and `retryAfterMs` for when the
next probe goes through. Other forges are unaffected; the breaker is
per-forge on purpose.

**Bitbucket checks fail while cloning works, or the reverse.** Bitbucket
is the one forge whose API host differs from its clone host: the API is
`api.bitbucket.org` and clones come from `bitbucket.org`. A network policy
or proxy that allows one does not necessarily allow the other, and the
symptom is one half of the check failing on its own. `npm run smoke`
exercises both halves against a real public Bitbucket repo.

**Every check returns 502 "git clone failed".** The deployment can't
clone: no `git` binary in the image, no outbound network, or a token
without access to the repo being checked. The smoke test is the fastest
way to confirm which. Clone errors are scrubbed of any token before they
reach a log line or a response, so the message will be about the failure
rather than the credential.

**`/ready` reports the history check failing.** The SQLite file is
missing, unwritable, or on a volume that went away. Evaluations still work
— the write is best-effort — but nothing is being recorded.

**A caller complains about stale results.** Results are cached for
`CACHE_TTL_MS` per repo. Tell them to send `refresh: true`, which
recomputes and stores the fresh answer, rather than waiting the TTL out.

**A caller is being rate-limited unexpectedly.** Only an `x-api-key`
matching the configured key gets its own budget; everything else is
limited per remote IP, so callers behind one NAT share a bucket. Every
response reports `X-RateLimit-Remaining` and `X-RateLimit-Reset`.
