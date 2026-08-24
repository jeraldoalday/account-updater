import { BitbucketClient } from "../../bitbucket/client";
import type { CommitHistorySummary, PushEventSummary, RepoRef } from "../../types";
import type { RepoProvider } from "../provider";

/**
 * Adapts BitbucketClient to the provider-agnostic RepoProvider interface,
 * exactly as the GitHub and GitLab adapters do.
 *
 * The third one is the interesting one. GitLab proved the seam held for a
 * forge shaped like GitHub - a commit endpoint with a total, an events
 * endpoint, the same two answers. Bitbucket is not shaped like GitHub: it
 * reports no commit total, paginates by cursor, and has no push-events API
 * at all. None of that reached past this file. The checks, cache keys,
 * audit rows, routes, and metrics did not learn a third forge exists; the
 * client absorbed the differences and this class stayed three lines of
 * delegation.
 */
export class BitbucketProvider implements RepoProvider {
  readonly id = "bitbucket" as const;

  private client: BitbucketClient;

  constructor(token?: string) {
    this.client = new BitbucketClient(token);
  }

  getCommitHistorySummary(ref: RepoRef): Promise<CommitHistorySummary> {
    return this.client.getCommitHistorySummary(ref);
  }

  getPushEventSummary(ref: RepoRef): Promise<PushEventSummary> {
    return this.client.getPushEventSummary(ref);
  }
}
