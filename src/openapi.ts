import { version } from "./version";

// Hand-written rather than generated from the zod schemas/routes — small
// enough surface area that keeping this in sync by hand is cheaper than
// wiring up a generator. Served as-is at GET /openapi.json.
export const openApiSpec = {
  openapi: "3.0.3",
  info: {
    title: "account-updater",
    description:
      "Checks whether a GitHub repo meets the eligibility requirements to connect an account.",
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
          "400": { description: "Invalid request body or unparseable repo reference." },
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
          "400": { description: "Invalid request body (empty or over the 20-repo cap)." },
          "401": { description: "Missing or invalid API key (only when API_KEY is configured)." },
          "429": { description: "Rate limit exceeded." }
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
            description: '"owner/name", a GitHub URL, or an SSH URL.',
            example: "octocat/Hello-World"
          },
          token: {
            type: "string",
            description: "Optional per-request GitHub token, overriding GITHUB_TOKEN."
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
      CheckResult: {
        type: "object",
        properties: {
          passed: { type: "boolean" },
          reasons: { type: "array", items: { type: "string" } }
        }
      },
      EligibilityResult: {
        type: "object",
        properties: {
          eligible: { type: "boolean" },
          repo: {
            type: "object",
            properties: { owner: { type: "string" }, repo: { type: "string" } }
          },
          checks: {
            type: "object",
            properties: {
              language: { $ref: "#/components/schemas/CheckResult" },
              size: { $ref: "#/components/schemas/CheckResult" },
              history: { $ref: "#/components/schemas/CheckResult" },
              activeDevelopment: { $ref: "#/components/schemas/CheckResult" }
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
          cacheMisses: { type: "number" }
        }
      }
    }
  },
  security: [{ apiKeyAuth: [] }]
} as const;
