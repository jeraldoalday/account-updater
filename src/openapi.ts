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
        summary: "Liveness/readiness check",
        security: [],
        responses: {
          "200": {
            description: "Service is up.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    status: { type: "string", example: "ok" },
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
          "Filter to one repo with `repo`, and cap the result count with `limit` " +
          "(default 50, max 200).",
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
            name: "limit",
            in: "query",
            required: false,
            schema: { type: "integer", minimum: 1, maximum: 200 }
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
    }
  },
  components: {
    securitySchemes: {
      apiKeyAuth: {
        type: "apiKey",
        in: "header",
        name: "x-api-key",
        description: "Required on /eligibility/* only when the server has API_KEY configured."
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
            maxItems: 20
          },
          token: { type: "string" }
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
