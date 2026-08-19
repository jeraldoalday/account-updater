# Contributing

Thanks for looking at this. This file covers how to get the service
running, what's expected of a change before it lands, and the few
conventions that aren't obvious from reading the code.

For how the service is put together — request lifecycle, module map,
extension seams — see [`docs/architecture.md`](docs/architecture.md).

## Getting set up

```bash
cp .env.example .env    # every value is optional for local development
npm install
npm run dev             # ts-node-dev, restarts on change
```

Nothing in `.env` is required to start the service. Two are worth setting
early anyway:

- `GITHUB_TOKEN` — without one you get GitHub's unauthenticated rate limit
  (60 requests/hour), which a handful of eligibility checks will exhaust.
  A public-repo-only token is enough unless you're testing private repos.
- `ELIGIBLE_LANGUAGES` — narrow it while testing if you want a repo to fail
  the language check on purpose.

Evaluating a repo shells out to `git clone`, so `git` has to be on your
PATH. Check the service against a real repo without leaving the terminal:

```bash
curl -s localhost:3000/eligibility/check \
  -H 'content-type: application/json' \
  -d '{"repo":"octocat/Hello-World"}' | jq
```

Or import [`docs/postman_collection.json`](docs/postman_collection.json)
into Postman or Insomnia — every endpoint is there with a runnable example
body.

## The commands that matter

| Command                           | What it does                                                    |
| --------------------------------- | --------------------------------------------------------------- |
| `npm test`                        | The whole suite (vitest, no watch)                              |
| `npm run typecheck`               | Type-checks `src/` **and** `test/`                              |
| `npm run lint`                    | ESLint                                                          |
| `npm run format` / `format:check` | Prettier write / verify                                         |
| `npm run build`                   | Compile to `dist/`                                              |
| `npm run stats`                   | Run the eligibility checks against _this_ repo, locally         |
| `npm run loadtest`                | Drive a running instance to exercise the rate limiter and cache |
| `npm run collection`              | Regenerate the Postman collection from the OpenAPI spec         |

CI runs typecheck, lint, format check, tests, build, and `npm audit` on
production dependencies. Run the first four locally before pushing; they
take a couple of seconds together.

## What a change should include

**Tests, in the same commit as the code.** Not for a coverage number — for
the specific thing that would otherwise silently break. The suite is fast
and hermetic: no test hits the network, clones a repo, or needs a Redis or
a real SQLite file (`:memory:` is used throughout), and it should stay that
way.

**A comment when the reason isn't in the code.** The bar here is _why_, not
_what_: a comment restating the line below it is noise, while one
explaining that push-event data is treated as neutral-when-missing because
GitHub only retains ~90 days of events saves the next person a research
detour. Several existing comments name the bug that motivated them; that's
deliberate.

**One unit of work per commit.** A refactor and a behaviour change in the
same commit are hard to review and harder to revert.

**Docs when the surface changes.** Adding an endpoint means adding it to
`src/openapi.ts` — a test compares the spec against the app's real routing
table in both directions, so an undocumented route fails the build — and
regenerating the collection with `npm run collection`.

## Commit messages

Subject line: imperative, sentence case, no type prefix, no trailing
period, and about what the change _achieves_ rather than which files it
touched.

```
Stop unparseable commit dates from silently passing the history check
Keep serving eligibility checks when the cache backend is down
```

Not `fix(history): date bug` or `Update client.ts`.

The body — which most changes deserve — explains the _why_: what was wrong
or missing, what the change does about it, and anything a reader would
otherwise have to reconstruct (a rejected alternative, a subtlety the tests
encode). Wrap it at ~72 columns.

## Conventions worth knowing

- **Thresholds live in one place.** `src/eligibility/thresholds.ts`, never
  inline in a check, and never restated in prose docs — a copy in the
  README would rot.
- **The spec is the API's description.** `src/openapi.ts` is hand-written
  but test-enforced against the routes and the metrics snapshot; the
  Postman collection is generated from it. Don't hand-edit generated files.
- **Optional dependencies stay optional.** The cache and the audit trail
  can both be unavailable without failing a request. If you add a
  dependency the request path _does_ need, say so explicitly and give
  `GET /ready` a way to report on it.
- **Caller-supplied tokens are never cached.** A result computed with a
  per-request token may reflect access to a private repo; caching it under
  a plain repo key would serve it to someone else. Anything touching the
  cache key or `cacheable` flag needs to keep that true.
- **Repo references are a trust boundary.** `parseRepoRef()` validates
  owner/repo and resolves the host against a fixed table, and clone URLs
  are rebuilt from that table rather than passed through. Loosening either
  is an SSRF question, not a parsing convenience.

## Adding support for another forge

The seam is `RepoProvider` in `src/providers/provider.ts`: two methods,
about commit-history shape and push cadence. Implement it, add an entry to
the registry in `src/providers/registry.ts`, and that's the change — the
checks, the clone path, and the HTTP layer are already provider-agnostic.
`src/providers/hosts.ts` already knows how to parse GitLab and Bitbucket
URLs, so those refs currently parse and then get a precise "not supported
yet" 400.
