import { GitLabClient } from "../../gitlab/client";
import type { CommitHistorySummary, PushEventSummary, RepoRef } from "../../types";
import type { RepoProvider } from "../provider";

/**
 * Adapts GitLabClient to the provider-agnostic RepoProvider interface, the
 * same way GitHubProvider adapts GitHubClient: the client is the transport
 * (URLs, pagination headers, retry policy) and this is the seam the rest of
 * the service talks to.
 *
 * That the two classes look near-identical is the point - it is the
 * evidence that the interface added for a hypothetical second provider was
 * the right shape, and that adding a real one costs a class and a registry
 * entry rather than changes spread through the eligibility checks.
 */
export class GitLabProvider implements RepoProvider {
  readonly id = "gitlab" as const;

  private client: GitLabClient;

  constructor(token?: string) {
    this.client = new GitLabClient(token);
  }

  getCommitHistorySummary(ref: RepoRef): Promise<CommitHistorySummary> {
    return this.client.getCommitHistorySummary(ref);
  }

  getPushEventSummary(ref: RepoRef): Promise<PushEventSummary> {
    return this.client.getPushEventSummary(ref);
  }
}
