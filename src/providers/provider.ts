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
 * What a forge's API can tell this service, independent of any one repo.
 *
 * Only push cadence varies today: GitHub and GitLab both have an events
 * API, and Bitbucket Cloud has none, so a Bitbucket repo is scored on
 * three signals where the others use four. That is a real difference in
 * how a verdict was reached, and a caller comparing results across forges
 * deserves to be able to see it rather than infer it.
 *
 * `pushEvents` means "the API exists", not "this repo has push data". A
 * particular repo can still report no signal - a token without the scope,
 * a project with no recorded activity - which is why PushEventSummary
 * carries its own `available` flag.
 */
export interface ProviderCapabilities {
  pushEvents: boolean;
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
    const name = displayName(providerId);
    const supportedNames = supported.map(displayName).join(", ");
    super(`${name} repositories are not supported yet (supported: ${supportedNames})`);
    this.name = "UnsupportedProviderError";
  }
}

/**
 * The forge's name, falling back to the raw id for one the host table does
 * not name.
 *
 * Every id reaching this today comes from the table, so the fallback is
 * unreachable - but this runs while *constructing an error*, and an error
 * constructor that can itself throw turns a clean 400 into a 502 with a
 * TypeError in it. The one place worth being forgiving is the path that
 * reports a failure.
 */
function displayName(id: ProviderId): string {
  return PROVIDER_HOSTS[id]?.displayName ?? id;
}
