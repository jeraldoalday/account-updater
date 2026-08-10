import { describe, expect, it } from "vitest";
import { openApiSpec } from "../src/openapi";

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
    const refs = collectRefs(openApiSpec.paths);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(ref.startsWith("#/components/schemas/")).toBe(true);
      resolveRef(openApiSpec, ref);
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
