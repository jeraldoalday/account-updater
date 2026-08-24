import { BitbucketProvider } from "./bitbucket/bitbucketProvider";
import { GitHubProvider } from "./github/githubProvider";
import { GitLabProvider } from "./gitlab/gitlabProvider";
import { PROVIDER_IDS, type ProviderId } from "./hosts";
import { UnsupportedProviderError, type RepoProvider, type RepoProviderFactory } from "./provider";

/**
 * The forges with a working implementation - now every forge the host
 * table names.
 *
 * Adding each of the last two was one entry here plus the provider class
 * it names, which is what the seam was built to be worth: no eligibility
 * check, cache key, audit row, or route learned that a second or third
 * forge exists.
 *
 * The map stays partial, and UnsupportedProviderError with it, even though
 * nothing is unsupported today. That pairing is what lets a forge be
 * *recognized* before it is *implemented*: a URL for it parses into a
 * precise "not supported yet" answer, with a 400 rather than a 502,
 * instead of a vague parse error. Deleting the seam now would mean
 * rebuilding it for the fourth forge.
 */
const FACTORIES: Partial<Record<ProviderId, RepoProviderFactory>> = {
  github: (token) => new GitHubProvider(token),
  gitlab: (token) => new GitLabProvider(token),
  bitbucket: (token) => new BitbucketProvider(token)
};

export function supportedProviderIds(): ProviderId[] {
  return PROVIDER_IDS.filter((id) => FACTORIES[id] !== undefined);
}

export function isProviderSupported(id: ProviderId): boolean {
  return FACTORIES[id] !== undefined;
}

/**
 * Builds the provider for a repo reference, bound to the given token.
 * Throws UnsupportedProviderError for a forge that parses but has no
 * implementation yet.
 */
export function createProvider(id: ProviderId, token?: string): RepoProvider {
  const factory = FACTORIES[id];
  if (!factory) {
    throw new UnsupportedProviderError(id, supportedProviderIds());
  }
  return factory(token);
}
