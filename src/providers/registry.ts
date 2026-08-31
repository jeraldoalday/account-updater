import { BitbucketProvider } from "./bitbucket/bitbucketProvider";
import { GitHubProvider } from "./github/githubProvider";
import { GitLabProvider } from "./gitlab/gitlabProvider";
import { breakerFor } from "./breakers";
import { GuardedProvider } from "./guardedProvider";
import { PROVIDER_IDS, type ProviderId } from "./hosts";
import {
  UnsupportedProviderError,
  type ProviderCapabilities,
  type RepoProvider,
  type RepoProviderFactory
} from "./provider";

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
interface Implementation {
  factory: RepoProviderFactory;
  /**
   * Declared here rather than on the provider instances so that answering
   * "what can this service do with Bitbucket" costs a map lookup instead
   * of constructing a provider - GitHub's builds an Octokit client.
   */
  capabilities: ProviderCapabilities;
}

const IMPLEMENTATIONS: Partial<Record<ProviderId, Implementation>> = {
  github: {
    factory: (token) => new GitHubProvider(token),
    capabilities: { pushEvents: true }
  },
  gitlab: {
    factory: (token) => new GitLabProvider(token),
    capabilities: { pushEvents: true }
  },
  bitbucket: {
    factory: (token) => new BitbucketProvider(token),
    // Bitbucket Cloud has no repository events API at all, so this one is
    // scored on three signals rather than four. See BitbucketClient.
    capabilities: { pushEvents: false }
  }
};

export function supportedProviderIds(): ProviderId[] {
  return PROVIDER_IDS.filter((id) => IMPLEMENTATIONS[id] !== undefined);
}

export function isProviderSupported(id: ProviderId): boolean {
  return IMPLEMENTATIONS[id] !== undefined;
}

/**
 * What the forge's API can tell this service, or null for one that has no
 * implementation - the honest answer there is "nothing", not a set of
 * capabilities that were never exercised.
 */
export function providerCapabilities(id: ProviderId): ProviderCapabilities | null {
  return IMPLEMENTATIONS[id]?.capabilities ?? null;
}

/**
 * Builds the provider for a repo reference, bound to the given token.
 * Throws UnsupportedProviderError for a forge that parses but has no
 * implementation yet.
 */
export function createProvider(id: ProviderId, token?: string): RepoProvider {
  const implementation = IMPLEMENTATIONS[id];
  if (!implementation) {
    throw new UnsupportedProviderError(id, supportedProviderIds());
  }
  // Wrapped here rather than inside each adapter, so a forge cannot be
  // added without its breaker: the seam that makes a new provider one
  // entry in this map is the same seam that makes it impossible to
  // forget. The breaker is per-forge and lives for the process, while the
  // provider itself is per-request (it carries the caller's token), which
  // is why the two are joined at this point and not in the constructor.
  return new GuardedProvider(implementation.factory(token), breakerFor(id));
}
