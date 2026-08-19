import { describe, expect, it, vi } from "vitest";
import { listRegisteredRoutes } from "./helpers/expressRoutes";
import { openApiSpec } from "../src/openapi";

// The history store opens SQLite on import of the admin route; stub it so
// this test only cares about the routing table.
vi.mock("../src/history/createHistoryStore", () => ({
  createHistoryStore: () => ({ listRecent: () => [], listForRepo: () => [], record: () => {} })
}));

const { createApp } = await import("../src/app");

const DOCUMENTED_METHODS = ["get", "post", "put", "patch", "delete"] as const;

function documentedRoutes(): string[] {
  const out: string[] = [];
  for (const [path, item] of Object.entries(openApiSpec.paths as Record<string, unknown>)) {
    for (const method of DOCUMENTED_METHODS) {
      if ((item as Record<string, unknown>)[method]) out.push(`${method.toUpperCase()} ${path}`);
    }
  }
  return out.sort();
}

describe("openapi route coverage", () => {
  // The spec is hand-written and lives apart from the routes, so the only
  // thing keeping the two in step is someone remembering. These compare
  // the real routing table against the documented one in both directions:
  // an endpoint shipped without docs, and a documented endpoint that was
  // renamed or removed, both fail here rather than in a caller's client.
  it("documents every route the app serves", () => {
    const registered = listRegisteredRoutes(createApp()).map((r) => `${r.method} ${r.path}`);
    expect(registered.length).toBeGreaterThan(0);

    const undocumented = registered.filter((route) => !documentedRoutes().includes(route));
    expect(undocumented).toEqual([]);
  });

  it("serves every route the spec documents", () => {
    const registered = listRegisteredRoutes(createApp()).map((r) => `${r.method} ${r.path}`);

    const missing = documentedRoutes().filter((route) => !registered.includes(route));
    expect(missing).toEqual([]);
  });
});
