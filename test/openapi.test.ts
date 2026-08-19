import { describe, expect, it } from "vitest";
import { openApiSpec } from "../src/openapi";
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
