import { GitHubClient } from "../../github/client";
import type { CommitHistorySummary, PushEventSummary, RepoRef } from "../../types";
import type { RepoProvider } from "../provider";

/**
 * Adapts the existing GitHubClient to the provider-agnostic RepoProvider
 * interface. The client stays where it is: it's the GitHub *transport*
 * (Octokit, pagination tricks, retry policy), while this class is the seam
 * the rest of the service talks to.
 */
export class GitHubProvider implements RepoProvider {
  readonly id = "github" as const;

  private client: GitHubClient;

  constructor(token?: string) {
    this.client = new GitHubClient(token);
  }

  getCommitHistorySummary(ref: RepoRef): Promise<CommitHistorySummary> {
    return this.client.getCommitHistorySummary(ref);
  }

  getPushEventSummary(ref: RepoRef): Promise<PushEventSummary> {
    return this.client.getPushEventSummary(ref);
  }
}
