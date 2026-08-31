import { CircuitOpenError, type CircuitBreaker } from "../net/circuitBreaker";
import type { CommitHistorySummary, PushEventSummary, RepoRef } from "../types";
import type { RepoProvider } from "./provider";

/** What a provider reports when it has no push data to offer. */
const NO_PUSH_EVENTS: PushEventSummary = {
  available: false,
  distinctPushDays: 0,
  maxSinglePushCommitShare: 0
};

/**
 * A provider that stops calling its forge once the forge stops answering.
 *
 * A decorator rather than a change to each adapter: the three adapters are
 * near-identical by design, and this is exactly the kind of behaviour that
 * would have been copied into all three and then diverged. Applied by the
 * registry, so a fourth forge gets it by existing.
 */
export class GuardedProvider implements RepoProvider {
  readonly id;

  constructor(
    private readonly inner: RepoProvider,
    private readonly breaker: CircuitBreaker
  ) {
    this.id = inner.id;
  }

  getCommitHistorySummary(ref: RepoRef): Promise<CommitHistorySummary> {
    return this.breaker.run(() => this.inner.getCommitHistorySummary(ref));
  }

  /**
   * Push events are best-effort by the provider contract - a forge with no
   * such API, or one that returns nothing, reports `available: false`
   * rather than throwing - and a refusal from the breaker is exactly that
   * case: no data, for a reason that isn't this repo's fault.
   *
   * So the refusal is turned into an absent signal instead of an error.
   * Nothing is hidden by doing that: the commit-history call above is
   * guarded by the same breaker and does throw, so a check against a forge
   * that isn't answering still fails - loudly, and for the right reason -
   * rather than quietly scoring the repo on whatever the clone found.
   *
   * A failure from the forge itself still propagates as before; only the
   * breaker's own refusal is absorbed here.
   */
  async getPushEventSummary(ref: RepoRef): Promise<PushEventSummary> {
    try {
      return await this.breaker.run(() => this.inner.getPushEventSummary(ref));
    } catch (err) {
      if (err instanceof CircuitOpenError) return NO_PUSH_EVENTS;
      throw err;
    }
  }
}
