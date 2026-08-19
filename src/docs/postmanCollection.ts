import { openApiSpec } from "../openapi";

/**
 * Converts the service's OpenAPI document into a Postman Collection v2.1
 * file (also what Insomnia imports), so trying an endpoint by hand doesn't
 * mean hand-assembling a curl command with a plausible request body first.
 *
 * Generated rather than hand-maintained: the spec is already the one
 * description of the API that tests keep honest (see the route-coverage
 * and metrics-drift guards), so deriving the collection from it means a
 * new endpoint shows up in the collection for free instead of becoming a
 * second thing to remember to update.
 */

const COLLECTION_SCHEMA = "https://schema.getpostman.com/json/collection/v2.1.0/collection.json";

export interface PostmanVariable {
  key: string;
  value: string;
  type?: string;
}

export interface PostmanHeader {
  key: string;
  value: string;
}

export interface PostmanQueryParam {
  key: string;
  value: string;
  description?: string;
  disabled?: boolean;
}

export interface PostmanRequest {
  method: string;
  header: PostmanHeader[];
  url: {
    raw: string;
    host: string[];
    path: string[];
    query?: PostmanQueryParam[];
  };
  description?: string;
  body?: { mode: "raw"; raw: string; options: { raw: { language: "json" } } };
}

export interface PostmanItem {
  name: string;
  request: PostmanRequest;
}

export interface PostmanFolder {
  name: string;
  item: PostmanItem[];
}

export interface PostmanCollection {
  info: { name: string; description?: string; schema: string; _postman_id?: string };
  variable: PostmanVariable[];
  item: PostmanFolder[];
}

type Json = unknown;
type JsonObject = Record<string, Json>;

function isObject(value: Json): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Resolves a local "#/components/schemas/Foo" reference against the spec. */
function resolveRef(ref: string, spec: JsonObject): JsonObject {
  const segments = ref.replace(/^#\//, "").split("/");
  let node: Json = spec;
  for (const segment of segments) {
    if (!isObject(node)) throw new Error(`Cannot resolve $ref "${ref}"`);
    node = node[segment];
  }
  if (!isObject(node)) throw new Error(`Cannot resolve $ref "${ref}"`);
  return node;
}

/**
 * Builds a filled-in example value for a schema: an `example` when the
 * spec gives one, otherwise a placeholder of the right shape. A body that
 * is merely well-typed but empty ({}), which is what a naive conversion
 * produces, is worse than useless in a collection - the whole point is
 * that the request is runnable as imported.
 */
export function exampleForSchema(schema: Json, spec: JsonObject, depth = 0): Json {
  if (!isObject(schema) || depth > 8) return null;

  if (typeof schema.$ref === "string") {
    return exampleForSchema(resolveRef(schema.$ref, spec), spec, depth + 1);
  }
  if (schema.example !== undefined) return schema.example;
  // A documented default is a better placeholder than a synthesized one:
  // it shows the value the server would have used anyway.
  if (schema.default !== undefined) return schema.default;

  // allOf composes one object out of several; oneOf/anyOf offer
  // alternatives, and the first is the one a caller is most likely to want
  // as a starting point.
  if (Array.isArray(schema.allOf)) {
    const merged: JsonObject = {};
    for (const part of schema.allOf) {
      const value = exampleForSchema(part, spec, depth + 1);
      if (isObject(value)) Object.assign(merged, value);
    }
    return merged;
  }
  const alternatives = schema.oneOf ?? schema.anyOf;
  if (Array.isArray(alternatives) && alternatives.length > 0) {
    return exampleForSchema(alternatives[0], spec, depth + 1);
  }

  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];

  switch (schema.type) {
    case "object": {
      const out: JsonObject = {};
      const properties = isObject(schema.properties) ? schema.properties : {};
      for (const [name, propSchema] of Object.entries(properties)) {
        out[name] = exampleForSchema(propSchema, spec, depth + 1);
      }
      return out;
    }
    case "array":
      return [exampleForSchema(schema.items, spec, depth + 1)];
    case "integer":
    case "number":
      return typeof schema.minimum === "number" ? schema.minimum : 0;
    case "boolean":
      return true;
    case "string":
      return typeof schema.format === "string" ? `<${schema.format}>` : "";
    default:
      return null;
  }
}

/**
 * Only the properties a caller actually sends: an example body listing
 * every optional field is noisier than one showing the required shape, and
 * a token field pre-filled with a placeholder invites sending it by
 * accident.
 */
function requestBodyExample(schema: Json, spec: JsonObject): Json {
  const resolved =
    isObject(schema) && typeof schema.$ref === "string" ? resolveRef(schema.$ref, spec) : schema;
  const example = exampleForSchema(resolved, spec);
  if (!isObject(resolved) || !isObject(example)) return example;

  const required = Array.isArray(resolved.required) ? (resolved.required as string[]) : [];
  if (required.length === 0) return example;
  return Object.fromEntries(
    required.filter((key) => key in example).map((key) => [key, example[key]])
  );
}

/** "/eligibility/check-batch" -> "eligibility"; "/health" -> "general". */
function folderNameFor(path: string): string {
  const [first] = path.replace(/^\//, "").split("/");
  return first && !first.includes(".") && first !== "health" ? first : "general";
}

function toQueryParams(parameters: Json, spec: JsonObject): PostmanQueryParam[] {
  if (!Array.isArray(parameters)) return [];
  return parameters
    .filter((p): p is JsonObject => isObject(p) && p.in === "query")
    .map((p) => {
      const example = exampleForSchema(p.schema, spec);
      return {
        key: String(p.name),
        value: example === null || example === "" ? "" : String(example),
        ...(typeof p.description === "string" ? { description: p.description } : {}),
        // Query parameters here are all optional filters, so they import
        // switched off - present as documentation, not silently applied.
        disabled: true
      };
    });
}

function buildItem(
  path: string,
  method: string,
  operation: JsonObject,
  spec: JsonObject,
  requiresApiKey: boolean
): PostmanItem {
  const headers: PostmanHeader[] = [];
  const bodySchema = isObject(operation.requestBody)
    ? (
        (operation.requestBody.content as JsonObject | undefined)?.["application/json"] as
          JsonObject | undefined
      )?.schema
    : undefined;

  if (bodySchema !== undefined) headers.push({ key: "Content-Type", value: "application/json" });
  // A collection variable rather than a literal, so importing it doesn't
  // bake a secret into a file people paste around.
  if (requiresApiKey) headers.push({ key: "x-api-key", value: "{{apiKey}}" });

  // Query parameters import disabled (see toQueryParams), so the raw URL
  // deliberately carries none of them.
  const query = toQueryParams(operation.parameters, spec);

  const request: PostmanRequest = {
    method: method.toUpperCase(),
    header: headers,
    url: {
      raw: `{{baseUrl}}${path}`,
      host: ["{{baseUrl}}"],
      path: path.replace(/^\//, "").split("/"),
      ...(query.length > 0 ? { query } : {})
    },
    ...(typeof operation.description === "string" ? { description: operation.description } : {})
  };

  if (bodySchema !== undefined) {
    request.body = {
      mode: "raw",
      raw: JSON.stringify(requestBodyExample(bodySchema, spec), null, 2),
      options: { raw: { language: "json" } }
    };
  }

  return {
    name:
      typeof operation.summary === "string" ? operation.summary : `${method.toUpperCase()} ${path}`,
    request
  };
}

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;

/**
 * `security: []` on an operation opts out of the collection-wide default,
 * which is how the spec marks the endpoints that never need an API key.
 */
function operationRequiresApiKey(operation: JsonObject, spec: JsonObject): boolean {
  if (Array.isArray(operation.security)) return operation.security.length > 0;
  return Array.isArray(spec.security) && spec.security.length > 0;
}

export function toPostmanCollection(
  spec: JsonObject = openApiSpec as unknown as JsonObject
): PostmanCollection {
  const info = isObject(spec.info) ? spec.info : {};
  const paths = isObject(spec.paths) ? spec.paths : {};
  const folders = new Map<string, PostmanFolder>();

  for (const [path, pathItem] of Object.entries(paths)) {
    if (!isObject(pathItem)) continue;
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (!isObject(operation)) continue;

      const folderName = folderNameFor(path);
      const folder = folders.get(folderName) ?? { name: folderName, item: [] };
      folder.item.push(
        buildItem(path, method, operation, spec, operationRequiresApiKey(operation, spec))
      );
      folders.set(folderName, folder);
    }
  }

  return {
    info: {
      name: `${info.title ?? "account-updater"} v${info.version ?? "0.0.0"}`,
      ...(typeof info.description === "string" ? { description: info.description } : {}),
      schema: COLLECTION_SCHEMA
    },
    variable: [
      { key: "baseUrl", value: "http://localhost:3000", type: "string" },
      { key: "apiKey", value: "", type: "string" }
    ],
    item: [...folders.values()]
  };
}

/**
 * The exact bytes written to docs/postman_collection.json, shared by the
 * generator CLI and the test that checks the committed file is current.
 */
export function renderCollectionJson(spec?: JsonObject): string {
  return `${JSON.stringify(toPostmanCollection(spec), null, 2)}\n`;
}
