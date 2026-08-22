import { config } from "../config";
import type { ProviderId } from "./hosts";

/**
 * The credential this service uses for a forge when the caller supplied
 * none of their own.
 *
 * This exists because "the token" stopped being a single thing the moment
 * a second forge was implemented. The HTTP layer used to default a request
 * to GITHUB_TOKEN before handing it down a provider-agnostic path, which
 * was correct while every ref was a GitHub ref and became a credential
 * leak the day GitLab refs started being evaluated: a GitHub PAT would be
 * sent to gitlab.com, both as an API header and inside the clone URL.
 *
 * So the default is resolved from the ref's provider and nowhere else. A
 * forge with no configured credential gets undefined, which means
 * unauthenticated - throttled, and unable to see private projects, but
 * never someone else's secret.
 */
export function defaultTokenFor(providerId: ProviderId): string | undefined {
  switch (providerId) {
    case "github":
      return config.githubToken;
    case "gitlab":
      return config.gitlabToken;
    default:
      // Reached only for a forge that parses but has no implementation, in
      // which case the registry refuses it before a token is ever used.
      return undefined;
  }
}
