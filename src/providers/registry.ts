import { GitHubProvider } from "./github/githubProvider";
import { GitLabProvider } from "./gitlab/gitlabProvider";
import { PROVIDER_IDS, type ProviderId } from "./hosts";
import { UnsupportedProviderError, type RepoProvider, type RepoProviderFactory } from "./provider";

/**
 * The forges with a working implementation. The host table in hosts.ts is
 * intentionally wider than this map - it knows how to *name* Bitbucket so
 * its URLs parse into a precise "not supported yet" answer instead of a
 * vague parse error.
 *
 * Adding GitLab was one entry here plus the provider class it names, which
 * is what the seam was built to be worth: no eligibility check, cache key,
 * audit row, or route learned that a second forge exists.
 */
const FACTORIES: Partial<Record<ProviderId, RepoProviderFactory>> = {
  github: (token) => new GitHubProvider(token),
  gitlab: (token) => new GitLabProvider(token)
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
