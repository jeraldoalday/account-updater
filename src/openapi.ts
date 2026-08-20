import { PROVIDER_IDS } from "./providers/hosts";
import { supportedProviderIds } from "./providers/registry";
import { version } from "./version";

// Hand-written rather than generated from the zod schemas/routes — small
// enough surface area that keeping this in sync by hand is cheaper than
// wiring up a generator. Served as-is at GET /openapi.json.
export const openApiSpec = {
  openapi: "3.0.3",
  info: {
    title: "account-updater",
    description:
      "Checks whether a repo meets the eligibility requirements to connect an account. " +
      `Repo references on ${PROVIDER_IDS.join(", ")} are recognized; ` +
      `evaluation is currently implemented for ${supportedProviderIds().join(", ")} only.`,
    version
  },
  paths: {
    "/health": {
      get: {
        summary: "Liveness check: is this process alive?",
        security: [],
        responses: {
          "200": {
            description:
              "The process is alive. Also answered while shutting down (with " +
              '`status: "draining"`), since a deliberate shutdown must not be restarted.',
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    status: { type: "string", enum: ["ok", "draining"], example: "ok" },
                    version: { type: "string" },
                    uptimeSeconds: { type: "number" }
                  }
                }
              }
            }
          }
        }
      }
    },
    "/ready": {
      get: {
        summary: "Readiness check: are this instance's dependencies usable?",
        description:
          "Distinct from /health, which only reports that the process is alive. Returns " +
          "503 when the cache backend or the SQLite audit trail is unreachable - both are " +
          "non-fatal per request by design (a cache error degrades to a miss, an audit " +
          "write failure is swallowed), so a load balancer has no other way to see them.",
        security: [],
        responses: {
          "200": {
            description: "All dependencies are usable.",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/ReadinessReport" } }
            }
          },
          "503": {
            description: "At least one dependency is unusable; see `checks` for which.",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/ReadinessReport" } }
            }
          }
        }
      }
    },
    "/metrics": {
      get: {
        summary: "In-memory operational counters for this process",
        security: [],
        responses: {
          "200": {
            description: "Current counters.",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Metrics" } } }
          }
        }
      }
    },
    "/metrics/prometheus": {
      get: {
        summary: "Prometheus text-exposition-format view of the same counters as GET /metrics",
        security: [],
        responses: {
          "200": {
            description: "Current counters, in Prometheus's text exposition format.",
            content: { "text/plain": { schema: { type: "string" } } }
          }
        }
      }
    },
    "/openapi.json": {
      get: {
        summary: "This spec",
        security: [],
        responses: { "200": { description: "The OpenAPI document." } }
      }
    },
    "/eligibility/check": {
      post: {
        summary: "Evaluate a single repo's eligibility",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/CheckRequest" }
            }
          }
        },
        responses: {
          "200": {
            description: "Evaluation completed (see `eligible` for the outcome).",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/EligibilityResult" } }
            }
          },
          "400": {
            description:
              "Invalid request body, unparseable repo reference, or a repo on a recognized " +
              "but not-yet-supported provider."
          },
          "401": { description: "Missing or invalid API key (only when API_KEY is configured)." },
          "429": { description: "Rate limit exceeded." },
          "502": { description: "Evaluation failed for a reason other than GitHub rate limiting." },
          "503": {
            description: "GitHub itself rate-limited the request after retries were exhausted.",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } }
            }
          }
        }
      }
    },
    "/eligibility/check-batch": {
      post: {
        summary: "Evaluate up to 20 repos in one request",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/CheckBatchRequest" }
            }
          }
        },
        responses: {
          "200": {
            description:
              "Always 200 once the request itself is valid — check each entry in `results` for its own outcome.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    results: {
                      type: "array",
                      items: {
                        oneOf: [
                          { $ref: "#/components/schemas/EligibilityResult" },
                          { $ref: "#/components/schemas/BatchEntryError" }
                        ]
                      }
                    }
                  }
                }
              }
            }
          },
          "400": {
            description:
              "Invalid request body (empty or over the 20-repo cap). Per-entry failures, " +
              "including a not-yet-supported provider, are reported inside a 200 response."
          },
          "401": { description: "Missing or invalid API key (only when API_KEY is configured)." },
          "429": { description: "Rate limit exceeded." }
        }
      }
    },
    "/admin/evaluations": {
      get: {
        summary: "Read-only view of the evaluation audit trail",
        description:
          "Lists past evaluations from the SQLite audit trail, most recent first. " +
          "Filters combine: `repo` for one repo, `eligible` for outcome, `since`/`until` " +
          "for a time window, and `limit` to cap the result count (default 50, max 200).",
        parameters: [
          {
            name: "repo",
            in: "query",
            required: false,
            schema: { type: "string" },
            description:
              '"owner/name" or a repo URL - when omitted, lists the most recent ' +
              "evaluations across all repos. Filtering is scoped to the reference's " +
              "provider as well as its owner/repo."
          },
          {
            name: "eligible",
            in: "query",
            required: false,
            schema: { type: "boolean" },
            description:
              "Restrict to evaluations that passed (true) or failed (false). Omit for both."
          },
          {
            name: "since",
            in: "query",
            required: false,
            schema: { type: "string", format: "date-time" },
            description:
              "Inclusive lower bound on when the evaluation happened, as an ISO-8601 " +
              "timestamp. An unparseable value is a 400, not an empty result."
          },
          {
            name: "until",
            in: "query",
            required: false,
            schema: { type: "string", format: "date-time" },
            description: "Inclusive upper bound, same format as `since`."
          },
          {
            name: "limit",
            in: "query",
            required: false,
            schema: { type: "integer", minimum: 1, maximum: 200, default: 50 }
          }
        ],
        responses: {
          "200": {
            description: "Matching evaluations, most recent first.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    evaluations: {
                      type: "array",
                      items: { $ref: "#/components/schemas/EvaluationRecord" }
                    }
                  }
                }
              }
            }
          },
          "400": { description: "Invalid `repo` or `limit` query parameter." },
          "401": { description: "Missing or invalid API key (only when API_KEY is configured)." }
        }
      }
    },
    "/admin/evaluations/summary": {
      get: {
        summary: "Aggregate view of the evaluation audit trail",
        description:
          "Counts over a window rather than the rows themselves: how many evaluations, " +
          "how many passed, across how many distinct repos, and which failures came up " +
          "most often. Failure reasons carry per-repo specifics (counts, language names), " +
          "so they are grouped with those parts replaced - `Only N lines of first-party " +
          "source found (need at least N).` - with one verbatim example per group. The " +
          "reason tally reads at most the 2000 most recent failures in the window; " +
          "`reasonsSampled` says how many it actually read.",
        parameters: [
          {
            name: "repo",
            in: "query",
            required: false,
            schema: { type: "string" },
            description: "Summarize one repo instead of all of them."
          },
          {
            name: "since",
            in: "query",
            required: false,
            schema: { type: "string", format: "date-time" },
            description: "Inclusive lower bound on the window, as an ISO-8601 timestamp."
          },
          {
            name: "until",
            in: "query",
            required: false,
            schema: { type: "string", format: "date-time" },
            description: "Inclusive upper bound, same format as `since`."
          },
          {
            name: "topReasons",
            in: "query",
            required: false,
            schema: { type: "integer", minimum: 1, maximum: 20, default: 5 },
            description: "How many failure-reason groups to return."
          }
        ],
        responses: {
          "200": {
            description: "Counts over the matching window.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/EvaluationSummary" }
              }
            }
          },
          "400": { description: "Invalid `repo`, `since`, `until`, or `topReasons`." },
          "401": { description: "Missing or invalid API key (only when API_KEY is configured)." }
        }
      }
    }
  },
  components: {
    securitySchemes: {
      apiKeyAuth: {
        type: "apiKey",
        in: "header",
        name: "x-api-key",
        description:
          "Required on /eligibility/* and /admin/* only when the server has API_KEY " +
          "configured. Both are rate-limited either way, each with its own budget, and " +
          "every response carries X-RateLimit-Limit, X-RateLimit-Remaining, and " +
          "X-RateLimit-Reset (unix seconds) so a caller can pace itself before it is refused."
      }
    },
    schemas: {
      CheckRequest: {
        type: "object",
        required: ["repo"],
        properties: {
          repo: {
            type: "string",
            description:
              '"owner/name" (assumed to be on GitHub), or an https/SSH URL on any ' +
              "recognized provider.",
            example: "octocat/Hello-World"
          },
          token: {
            type: "string",
            description:
              "Optional per-request provider token, overriding GITHUB_TOKEN. Results " +
              "computed with it are never cached."
          },
          refresh: {
            type: "boolean",
            default: false,
            description:
              "Recompute instead of answering from cache, then store the fresh result. " +
              "For rechecking a repo whose problem was just fixed, rather than waiting " +
              "out CACHE_TTL_MS. Always clones and calls the provider API, so it counts " +
              "against the rate limit like any other check."
          }
        }
      },
      CheckBatchRequest: {
        type: "object",
        required: ["repos"],
        properties: {
          repos: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            maxItems: 20,
            example: ["octocat/Hello-World", "rust-lang/rust"]
          },
          token: { type: "string" },
          refresh: {
            type: "boolean",
            default: false,
            description: "Recompute every entry instead of answering from cache."
          }
        }
      },
      RepoRef: {
        type: "object",
        description: "The repo an evaluation refers to, including which provider it lives on.",
        properties: {
          provider: { type: "string", enum: PROVIDER_IDS },
          owner: { type: "string" },
          repo: { type: "string" }
        }
      },
      CheckResult: {
        type: "object",
        properties: {
          passed: { type: "boolean" },
          reasons: { type: "array", items: { type: "string" } }
        }
      },
      ActiveDevelopmentCheckResult: {
        description:
          "Whether commit history looks like organic incremental work rather than a bulk push, " +
          "expressed as a blended score across four signals (day spread, push-event bulk delivery, " +
          "commit-message pattern quality, and contributor diversity).",
        allOf: [
          { $ref: "#/components/schemas/CheckResult" },
          {
            type: "object",
            properties: {
              score: { type: "number", minimum: 0, maximum: 1 },
              distinctCommitDays: { type: "integer" },
              maxSingleDayCommitShare: { type: "number", minimum: 0, maximum: 1 },
              authorStats: {
                type: "object",
                properties: {
                  sampled: { type: "integer" },
                  distinctAuthors: { type: "integer" },
                  maxAuthorShare: { type: "number", minimum: 0, maximum: 1 }
                }
              },
              messageStats: {
                type: "object",
                properties: {
                  sampled: { type: "integer" },
                  distinctMessageRatio: { type: "number", minimum: 0, maximum: 1 },
                  genericMessageShare: { type: "number", minimum: 0, maximum: 1 }
                }
              },
              pushEvents: {
                type: "object",
                properties: {
                  available: { type: "boolean" },
                  distinctPushDays: { type: "integer" },
                  maxSinglePushCommitShare: { type: "number", minimum: 0, maximum: 1 }
                }
              }
            }
          }
        ]
      },
      EligibilityResult: {
        type: "object",
        properties: {
          eligible: { type: "boolean" },
          repo: { $ref: "#/components/schemas/RepoRef" },
          checks: {
            type: "object",
            properties: {
              language: { $ref: "#/components/schemas/CheckResult" },
              size: { $ref: "#/components/schemas/CheckResult" },
              history: { $ref: "#/components/schemas/CheckResult" },
              activeDevelopment: { $ref: "#/components/schemas/ActiveDevelopmentCheckResult" }
            }
          },
          reasons: { type: "array", items: { type: "string" } }
        }
      },
      BatchEntryError: {
        type: "object",
        properties: {
          repo: { type: "string" },
          error: { type: "string" },
          rateLimit: { $ref: "#/components/schemas/RateLimitInfo" }
        }
      },
      RateLimitInfo: {
        type: "object",
        properties: {
          remaining: { type: "number" },
          resetAt: { type: "string", format: "date-time" },
          retryAfterSeconds: { type: "number" }
        }
      },
      ErrorResponse: {
        type: "object",
        properties: {
          error: { type: "string" },
          rateLimit: { $ref: "#/components/schemas/RateLimitInfo" }
        }
      },
      DependencyStatus: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          error: {
            type: "string",
            description: "Why the dependency check failed. Absent when `ok` is true."
          }
        }
      },
      ReadinessReport: {
        type: "object",
        properties: {
          ready: { type: "boolean" },
          draining: {
            type: "boolean",
            description:
              "True once the process has begun shutting down. It keeps serving in-flight " +
              "and newly-arrived requests for a drain window, but reports itself not-ready " +
              "immediately so a load balancer stops routing to it before the listener closes."
          },
          checks: {
            type: "object",
            properties: {
              cache: { $ref: "#/components/schemas/DependencyStatus" },
              history: { $ref: "#/components/schemas/DependencyStatus" }
            }
          }
        }
      },
      Metrics: {
        type: "object",
        properties: {
          requestsTotal: { type: "number" },
          requestsByStatusClass: { type: "object", additionalProperties: { type: "number" } },
          eligibilityChecksTotal: { type: "number" },
          eligibilityPassed: { type: "number" },
          eligibilityFailed: { type: "number" },
          cacheHits: { type: "number" },
          cacheMisses: { type: "number" },
          cacheRefreshes: {
            type: "number",
            description:
              "Requests that asked for a recomputation with `refresh`, bypassing a cached " +
              "result. Counted apart from misses because they are the expensive path."
          },
          cacheErrors: {
            type: "number",
            description:
              "Cache reads/writes that failed outright (e.g. the shared Redis backend " +
              "being unreachable). The affected requests still succeed by computing the " +
              "result, so a non-zero value here explains a collapsed hit rate."
          },
          stageDurations: {
            type: "object",
            additionalProperties: {
              type: "object",
              properties: {
                count: { type: "number" },
                avgMs: { type: "number" },
                maxMs: { type: "number" }
              }
            }
          }
        }
      },
      EvaluationSummary: {
        type: "object",
        properties: {
          total: { type: "integer" },
          passed: { type: "integer" },
          failed: { type: "integer" },
          passRate: {
            type: "number",
            nullable: true,
            description: "Share of evaluations that passed, or null when there were none.",
            minimum: 0,
            maximum: 1
          },
          distinctRepos: { type: "integer" },
          firstEvaluatedAt: { type: "string", format: "date-time" },
          lastEvaluatedAt: { type: "string", format: "date-time" },
          reasonsSampled: {
            type: "integer",
            description: "How many failed evaluations the reason tally below is based on."
          },
          topFailureReasons: {
            type: "array",
            items: {
              type: "object",
              properties: {
                reason: {
                  type: "string",
                  description: "The reason with its varying parts replaced by placeholders."
                },
                count: { type: "integer" },
                example: {
                  type: "string",
                  description: "One verbatim reason folded into this group."
                }
              }
            }
          }
        }
      },
      EvaluationRecord: {
        type: "object",
        properties: {
          id: { type: "integer" },
          repo: { $ref: "#/components/schemas/RepoRef" },
          evaluatedAt: { type: "string", format: "date-time" },
          eligible: { type: "boolean" },
          reasons: { type: "array", items: { type: "string" } }
        }
      }
    }
  },
  security: [{ apiKeyAuth: [] }]
} as const;
