import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  exampleForSchema,
  renderCollectionJson,
  toPostmanCollection
} from "../src/docs/postmanCollection";
import { DEFAULT_OUTPUT_PATH } from "../src/cli/genCollection";
import { openApiSpec } from "../src/openapi";

type JsonObject = Record<string, unknown>;

const spec = openApiSpec as unknown as JsonObject;

function allItems() {
  return toPostmanCollection().item.flatMap((folder) =>
    folder.item.map((item) => ({ folder: folder.name, ...item }))
  );
}

function itemFor(rawUrl: string) {
  const item = allItems().find((i) => i.request.url.raw === rawUrl);
  if (!item) throw new Error(`No collection item for ${rawUrl}`);
  return item;
}

describe("exampleForSchema", () => {
  const miniSpec: JsonObject = {
    components: {
      schemas: {
        Inner: { type: "object", properties: { flag: { type: "boolean" } } }
      }
    }
  };

  it("prefers an explicit example over a synthesized placeholder", () => {
    expect(exampleForSchema({ type: "string", example: "octocat/Hello-World" }, miniSpec)).toBe(
      "octocat/Hello-World"
    );
  });

  it("falls back to a documented default before synthesizing one", () => {
    expect(exampleForSchema({ type: "integer", minimum: 1, default: 50 }, miniSpec)).toBe(50);
  });

  it("follows a local $ref", () => {
    expect(exampleForSchema({ $ref: "#/components/schemas/Inner" }, miniSpec)).toEqual({
      flag: true
    });
  });

  it("merges allOf branches into a single object", () => {
    const merged = exampleForSchema(
      {
        allOf: [
          { $ref: "#/components/schemas/Inner" },
          { type: "object", properties: { score: { type: "number" } } }
        ]
      },
      miniSpec
    );
    expect(merged).toEqual({ flag: true, score: 0 });
  });

  it("picks the first alternative of a oneOf, since a body can only be one", () => {
    const value = exampleForSchema(
      { oneOf: [{ type: "string", example: "first" }, { type: "number" }] },
      miniSpec
    );
    expect(value).toBe("first");
  });

  it("uses the first enum value", () => {
    expect(exampleForSchema({ type: "string", enum: ["github", "gitlab"] }, miniSpec)).toBe(
      "github"
    );
  });

  it("wraps array items in a one-element array", () => {
    expect(exampleForSchema({ type: "array", items: { type: "boolean" } }, miniSpec)).toEqual([
      true
    ]);
  });

  it("stops recursing rather than hanging on a self-referential schema", () => {
    const cyclic: JsonObject = {
      components: {
        schemas: {
          Node: { type: "object", properties: { child: { $ref: "#/components/schemas/Node" } } }
        }
      }
    };
    expect(() => exampleForSchema({ $ref: "#/components/schemas/Node" }, cyclic)).not.toThrow();
  });
});

describe("toPostmanCollection", () => {
  it("names the collection after the spec's title and version", () => {
    const collection = toPostmanCollection();
    expect(collection.info.name).toContain("account-updater");
    expect(collection.info.schema).toContain("v2.1.0");
  });

  it("covers every documented operation exactly once", () => {
    const documented = Object.entries(spec.paths as JsonObject).flatMap(([path, item]) =>
      Object.keys(item as JsonObject).map((method) => `${method.toUpperCase()} ${path}`)
    );
    const generated = allItems().map(
      (i) => `${i.request.method} ${i.request.url.raw.replace("{{baseUrl}}", "")}`
    );
    expect(generated.sort()).toEqual(documented.sort());
  });

  it("groups items into folders by their top-level path segment", () => {
    const folders = toPostmanCollection().item.map((f) => f.name);
    expect(folders).toContain("eligibility");
    expect(folders).toContain("admin");
    // /health and /openapi.json have no shared segment worth a folder.
    expect(folders).toContain("general");
  });

  it("sends a runnable JSON body on the endpoints that take one", () => {
    const item = itemFor("{{baseUrl}}/eligibility/check");
    expect(item.request.header).toContainEqual({ key: "Content-Type", value: "application/json" });
    expect(JSON.parse(item.request.body?.raw ?? "null")).toEqual({ repo: "octocat/Hello-World" });
  });

  it("keeps optional fields out of the example body", () => {
    // `token` is optional and sending one by accident would skip the cache
    // and, worse, imply access the caller may not have meant to share.
    const body = JSON.parse(itemFor("{{baseUrl}}/eligibility/check").request.body?.raw ?? "{}");
    expect(body).not.toHaveProperty("token");
  });

  it("references the API key as a collection variable rather than a literal", () => {
    const item = itemFor("{{baseUrl}}/eligibility/check");
    expect(item.request.header).toContainEqual({ key: "x-api-key", value: "{{apiKey}}" });

    const variables = toPostmanCollection().variable;
    expect(variables.map((v) => v.key)).toEqual(["baseUrl", "apiKey"]);
    // Nothing secret is committed - the value is filled in per environment.
    expect(variables.find((v) => v.key === "apiKey")?.value).toBe("");
  });

  it("omits the API key header on endpoints that opt out of auth", () => {
    // `security: []` in the spec marks the open endpoints; /health being
    // sent an API key header would be misleading.
    expect(itemFor("{{baseUrl}}/health").request.header).toEqual([]);
    expect(itemFor("{{baseUrl}}/metrics").request.header).toEqual([]);
  });

  it("imports query parameters disabled, so they document without applying", () => {
    const query = itemFor("{{baseUrl}}/admin/evaluations").request.url.query ?? [];
    expect(query.map((q) => q.key)).toEqual(["repo", "limit"]);
    expect(query.every((q) => q.disabled)).toBe(true);
    expect(query.find((q) => q.key === "limit")?.value).toBe("50");
  });

  it("splits the URL into the path segments Postman expects", () => {
    expect(itemFor("{{baseUrl}}/eligibility/check-batch").request.url).toMatchObject({
      host: ["{{baseUrl}}"],
      path: ["eligibility", "check-batch"]
    });
  });
});

describe("the committed collection file", () => {
  it("matches what the generator produces today", () => {
    // Committed so it can be imported straight from a clone; this fails
    // when the spec changes and `npm run collection` wasn't re-run.
    const onDisk = readFileSync(join(__dirname, "..", DEFAULT_OUTPUT_PATH), "utf8");
    expect(onDisk).toBe(renderCollectionJson());
  });
});
