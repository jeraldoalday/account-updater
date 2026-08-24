import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { describeProviders } from "../src/routes/providers.route";
import { PROVIDER_IDS, providerHost } from "../src/providers/hosts";
import { isProviderSupported, providerCapabilities } from "../src/providers/registry";
import { parseRepoRef } from "../src/utils/repoUrl";

// The history store opens SQLite on import of the admin route, and the
// GitHub provider builds an Octokit; neither has anything to do with
// describing providers.
vi.mock("../src/history/createHistoryStore", () => ({
  createHistoryStore: () => ({ list: () => [], record: () => {}, summarize: () => ({}) })
}));

const { createApp } = await import("../src/app");

describe("describeProviders", () => {
  it("describes every forge the host table names", () => {
    expect(describeProviders().map((p) => p.id)).toEqual([...PROVIDER_IDS]);
  });

  it("reports each forge's clone host and display name from the host table", () => {
    for (const provider of describeProviders()) {
      const spec = providerHost(provider.id);
      expect(provider.host).toBe(spec.host);
      expect(provider.displayName).toBe(spec.displayName);
      expect(provider.nestedNamespaces).toBe(spec.supportsNestedNamespaces);
    }
  });

  it("reports support from the registry rather than restating it", () => {
    // The point of the endpoint is that it cannot claim support the
    // service does not have.
    for (const provider of describeProviders()) {
      expect(provider.supported).toBe(isProviderSupported(provider.id));
    }
  });

  it("gives an example every forge's own parser accepts", () => {
    // An example that doesn't parse is worse than none: a caller copies it
    // and gets a 400 from the service that suggested it.
    for (const provider of describeProviders()) {
      const ref = parseRepoRef(provider.example);
      expect(ref.provider).toBe(provider.id);
    }
  });

  it("reports which signals a forge's API can contribute", () => {
    for (const provider of describeProviders()) {
      const capabilities = providerCapabilities(provider.id);
      if (capabilities === null) {
        // "Nothing", rather than a set of capabilities nothing exercised.
        expect(provider.signals).toBeUndefined();
      } else {
        expect(provider.signals).toEqual({ pushEvents: capabilities.pushEvents });
      }
    }
  });

  it("says Bitbucket contributes no push-event signal", () => {
    // Not a detail: it is why a Bitbucket repo is scored on three signals
    // where a GitHub one uses four, and a caller comparing verdicts across
    // forges would otherwise have to guess at the difference.
    const bitbucket = describeProviders().find((p) => p.id === "bitbucket");
    expect(bitbucket?.signals).toEqual({ pushEvents: false });

    const github = describeProviders().find((p) => p.id === "github");
    expect(github?.signals).toEqual({ pushEvents: true });
  });

  it("does not report whether a credential is configured", () => {
    // An operator's question, answered by `npm run doctor`. This endpoint
    // is unauthenticated, so it must not describe the environment.
    const serialized = JSON.stringify(describeProviders());
    expect(serialized).not.toMatch(/token|credential/i);
  });
});

describe("GET /providers", () => {
  it("answers with the recognized forges", async () => {
    const res = await request(createApp()).get("/providers");

    expect(res.status).toBe(200);
    expect(res.body.providers).toEqual(describeProviders());
  });

  it("needs no API key, since the caller has not named a repo yet", async () => {
    // Mounted outside the /eligibility middleware on purpose: a client
    // asking what it may send should not have to be authorized first.
    const res = await request(createApp()).get("/providers").set("x-api-key", "");

    expect(res.status).toBe(200);
  });

  it("is not rate-limited like an eligibility check", async () => {
    // It reads two in-memory tables; nothing about it is worth a budget.
    const app = createApp();
    for (let i = 0; i < 25; i++) {
      const res = await request(app).get("/providers");
      expect(res.status).toBe(200);
    }
  });
});
