import type { CommitHistorySummary, PushEventSummary, RepoRef } from "../types";
import { PROVIDER_HOSTS, type ProviderId } from "./hosts";

/**
 * Everything the eligibility checks need from a forge, and nothing else.
 *
 * Deliberately narrow: the checks care about *commit history shape* and
 * *push cadence*, not about how a particular API paginates, authenticates,
 * or names its event types. A GitLab or Bitbucket implementation therefore
 * has to satisfy two methods rather than match GitHub's API surface, and
 * the checks in src/eligibility stay provider-agnostic.
 *
 * The file-tree side of a check needs no provider method at all: it's a
 * plain `git clone` against a URL built from the provider's host table.
 */
export interface RepoProvider {
  readonly id: ProviderId;

  /**
   * Exact commit count, first/last commit dates, and a bounded sample of
   * recent commits summarized into day/author/message distributions.
   * Implementations are expected to keep this cheap on huge repos rather
   * than walking the entire history.
   */
  getCommitHistorySummary(ref: RepoRef): Promise<CommitHistorySummary>;

  /**
   * Recent push activity, as a secondary "was this pushed all at once?"
   * signal. Best-effort by contract: a provider with no such API, or one
   * that returns nothing for this repo, must report `available: false`
   * rather than throwing, so a missing signal is treated as neutral
   * instead of failing the whole check.
   */
  getPushEventSummary(ref: RepoRef): Promise<PushEventSummary>;
}

/**
 * Builds a provider bound to a specific token. A factory rather than a
 * singleton because the token varies per request: a caller can supply
 * their own token to have a private repo evaluated.
 */
export type RepoProviderFactory = (token?: string) => RepoProvider;

/**
 * Thrown when a ref names a forge this service can parse but not yet
 * evaluate. Carries the provider id so the HTTP layer can answer with a
 * 400 ("you asked for something we don't do") rather than a 502 ("the
 * upstream broke").
 */
export class UnsupportedProviderError extends Error {
  constructor(
    readonly providerId: ProviderId,
    readonly supported: readonly ProviderId[]
  ) {
    const name = PROVIDER_HOSTS[providerId].displayName;
    const supportedNames = supported.map((id) => PROVIDER_HOSTS[id].displayName).join(", ");
    super(`${name} repositories are not supported yet (supported: ${supportedNames})`);
    this.name = "UnsupportedProviderError";
  }
}
