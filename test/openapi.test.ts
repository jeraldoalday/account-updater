import { describe, expect, it } from "vitest";
import { openApiSpec, providerSupportSentence } from "../src/openapi";
import { serviceSnapshot } from "../src/metrics/serviceSnapshot";
import { toPrometheusText } from "../src/metrics/prometheusFormat";
import { PROVIDER_IDS } from "../src/providers/hosts";
import { supportedProviderIds } from "../src/providers/registry";

function resolveRef(spec: unknown, ref: string): unknown {
  const path = ref.replace(/^#\//, "").split("/");
  let node: unknown = spec;
  for (const segment of path) {
    expect(node && typeof node === "object" && segment in node).toBe(true);
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

function collectRefs(node: unknown, refs: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, refs);
  } else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string") refs.push(value);
      else collectRefs(value, refs);
    }
  }
  return refs;
}

describe("openApiSpec", () => {
  it("has a title, version, and at least one path", () => {
    expect(openApiSpec.info.title).toBeTruthy();
    expect(openApiSpec.info.version).toBeTruthy();
    expect(Object.keys(openApiSpec.paths).length).toBeGreaterThan(0);
  });

  it("resolves every $ref to an actual schema (catches typos in hand-written refs)", () => {
    const refs = [
      ...collectRefs(openApiSpec.paths),
      ...collectRefs(openApiSpec.components.schemas)
    ];
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(ref.startsWith("#/components/schemas/")).toBe(true);
      resolveRef(openApiSpec, ref);
    }
  });

  it("documents the active-development score fields via an allOf extension of CheckResult", () => {
    const schema = openApiSpec.components.schemas.ActiveDevelopmentCheckResult;
    expect(schema.allOf[0].$ref).toBe("#/components/schemas/CheckResult");
    expect(schema.allOf[1].properties.score).toBeTruthy();

    const checks = openApiSpec.components.schemas.EligibilityResult.properties.checks.properties;
    expect(checks.activeDevelopment.$ref).toBe("#/components/schemas/ActiveDevelopmentCheckResult");
  });

  it("describes results as provider-scoped repo references", () => {
    const repoRef = openApiSpec.components.schemas.RepoRef;
    expect(repoRef.properties.provider.enum).toEqual(PROVIDER_IDS);

    // Both the live result and the audit-trail record name the same shape,
    // so a client can't be told the provider in one place and not the other.
    expect(openApiSpec.components.schemas.EligibilityResult.properties.repo.$ref).toBe(
      "#/components/schemas/RepoRef"
    );
    expect(openApiSpec.components.schemas.EvaluationRecord.properties.repo.$ref).toBe(
      "#/components/schemas/RepoRef"
    );
  });

  it("says which providers are recognized and which are actually implemented", () => {
    // Derived from the registry rather than restated, so the spec can't
    // claim support for a provider that has no implementation.
    for (const id of supportedProviderIds()) {
      expect(openApiSpec.info.description).toContain(id);
    }
    for (const id of PROVIDER_IDS) {
      expect(openApiSpec.info.description).toContain(id);
    }
    expect(openApiSpec.info.description).toContain(providerSupportSentence());
  });

  it("only calls out a gap between recognized and implemented when there is one", () => {
    // "implemented for github, gitlab, bitbucket only" - when those are
    // also the only recognized forges - reads like a limitation that
    // doesn't exist, and tells a caller nothing.
    const all = PROVIDER_IDS.join(", ");
    const gap = PROVIDER_IDS.filter((id) => !supportedProviderIds().includes(id));

    if (gap.length === 0) {
      expect(providerSupportSentence()).toBe(
        `Repo references on ${all} are recognized and evaluated.`
      );
      expect(providerSupportSentence()).not.toContain("only");
    } else {
      expect(providerSupportSentence()).toContain(
        `implemented for ${supportedProviderIds().join(", ")} only`
      );
    }
  });

  it("documents exactly the counters GET /metrics actually returns", () => {
    // The spec is hand-written, so a counter added to the snapshot can
    // silently never reach it - which is how `cacheErrors` ended up
    // exported by /metrics and /metrics/prometheus but absent here. Compare
    // both directions so neither a new counter nor a removed one drifts.
    const documented = Object.keys(openApiSpec.components.schemas.Metrics.properties).sort();
    const actual = Object.keys(serviceSnapshot()).sort();
    expect(documented).toEqual(actual);
  });

  it("exports every documented counter in the Prometheus rendering too", () => {
    // Same drift, other exporter: a counter can be documented and returned
    // as JSON while the Prometheus text rendering forgets it.
    const text = toPrometheusText(serviceSnapshot());
    const scalarCounters = Object.entries(openApiSpec.components.schemas.Metrics.properties)
      .filter(([, schema]) => (schema as { type?: string }).type === "number")
      .map(([name]) => name);

    expect(scalarCounters.length).toBeGreaterThan(0);
    for (const name of scalarCounters) {
      // requestsTotal -> account_updater_requests_total, cacheErrors ->
      // account_updater_cache_errors_total.
      const snake = name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
      const metricName = `account_updater_${snake.endsWith("_total") ? snake : `${snake}_total`}`;
      expect(text).toContain(metricName);
    }
  });

  it("documents both eligibility endpoints with the request bodies the routes actually accept", () => {
    const single = openApiSpec.paths["/eligibility/check"].post;
    expect(single.requestBody.content["application/json"].schema.$ref).toBe(
      "#/components/schemas/CheckRequest"
    );

    const batch = openApiSpec.paths["/eligibility/check-batch"].post;
    expect(batch.requestBody.content["application/json"].schema.$ref).toBe(
      "#/components/schemas/CheckBatchRequest"
    );
  });
});
