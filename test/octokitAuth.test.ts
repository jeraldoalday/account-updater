import { describe, expect, it } from "vitest";
import { createAppAuth } from "@octokit/auth-app";
import { resolveOctokitAuth } from "../src/github/octokitAuth";

const appAuthConfig = {
  appId: "12345",
  privateKey: "-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----",
  installationId: 67890
};

describe("resolveOctokitAuth", () => {
  it("uses the token directly when one is provided, ignoring app auth config", () => {
    const options = resolveOctokitAuth("ghp_abc123", appAuthConfig);
    expect(options).toEqual({ auth: "ghp_abc123" });
  });

  it("falls back to GitHub App installation auth when no token is given", () => {
    const options = resolveOctokitAuth(undefined, appAuthConfig);
    expect(options.authStrategy).toBe(createAppAuth);
    expect(options.auth).toEqual({
      appId: "12345",
      privateKey: appAuthConfig.privateKey,
      installationId: 67890
    });
  });

  it("returns unauthenticated options when neither a token nor app auth config is available", () => {
    expect(resolveOctokitAuth(undefined, undefined)).toEqual({});
  });
});
