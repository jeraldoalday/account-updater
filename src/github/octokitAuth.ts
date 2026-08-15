import { createAppAuth } from "@octokit/auth-app";
import type { Octokit } from "@octokit/rest";

export interface GitHubAppAuthConfig {
  appId: string;
  privateKey: string;
  installationId: number;
}

export type OctokitOptions = ConstructorParameters<typeof Octokit>[0];

// Precedence: an explicit token (a per-request caller token, e.g. the
// connecting user's own OAuth token, or the shared GITHUB_TOKEN PAT once
// the caller and config layers have already merged those two) always wins.
// With no token at all, fall back to authenticating as the configured
// GitHub App installation - higher rate limits and no shared PAT to leak -
// if one is configured. With neither, requests go out unauthenticated.
export function resolveOctokitAuth(
  token: string | undefined,
  appAuthConfig: GitHubAppAuthConfig | undefined
): OctokitOptions {
  if (token) return { auth: token };

  if (appAuthConfig) {
    return {
      authStrategy: createAppAuth,
      auth: {
        appId: appAuthConfig.appId,
        privateKey: appAuthConfig.privateKey,
        installationId: appAuthConfig.installationId
      }
    };
  }

  return {};
}
