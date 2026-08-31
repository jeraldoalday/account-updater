import { describe, expect, it, vi } from "vitest";
import { CircuitBreaker, CircuitOpenError } from "../src/net/circuitBreaker";
import { GuardedProvider } from "../src/providers/guardedProvider";
import type { RepoProvider } from "../src/providers/provider";
import type { CommitHistorySummary, PushEventSummary } from "../src/types";

const ref = { provider: "github" as const, owner: "acme", repo: "widgets" };

const HISTORY = {
  commitCount: 200,
  firstCommitDate: "2026-01-01T00:00:00Z",
  lastCommitDate: "2026-01-20T00:00:00Z",
  historyDays: 19,
  commitsByDay: {},
  distinctCommitDays: 15,
  maxSingleDayCommitShare: 0.1,
  authorStats: { sampled: 200, distinctAuthors: 3, maxAuthorShare: 0.5 },
  messageStats: { sampled: 200, distinctMessageRatio: 0.9, genericMessageShare: 0.05 },
  truncated: false
} satisfies CommitHistorySummary;

const PUSH_EVENTS = {
  available: true,
  distinctPushDays: 9,
  maxSinglePushCommitShare: 0.2
} satisfies PushEventSummary;

function guarded(inner: Partial<RepoProvider> = {}) {
  const getCommitHistorySummary = vi.fn().mockResolvedValue(HISTORY);
  const getPushEventSummary = vi.fn().mockResolvedValue(PUSH_EVENTS);
  const stub: RepoProvider = {
    id: "github",
    getCommitHistorySummary,
    getPushEventSummary,
    ...inner
  };
  const breaker = new CircuitBreaker("GitHub", { failureThreshold: 2, openMs: 30_000 });
  return {
    provider: new GuardedProvider(stub, breaker),
    breaker,
    getCommitHistorySummary,
    getPushEventSummary
  };
}

async function trip(provider: GuardedProvider, times = 2): Promise<void> {
  for (let i = 0; i < times; i++) {
    await provider.getCommitHistorySummary(ref).catch(() => undefined);
  }
}

describe("GuardedProvider", () => {
  it("keeps the forge it is wrapping, so nothing downstream has to unwrap it", () => {
    expect(guarded().provider.id).toBe("github");
  });

  it("passes a healthy call through untouched", async () => {
    const { provider, getCommitHistorySummary } = guarded();

    await expect(provider.getCommitHistorySummary(ref)).resolves.toEqual(HISTORY);
    expect(getCommitHistorySummary).toHaveBeenCalledWith(ref);
  });

  it("passes push events through untouched", async () => {
    const { provider } = guarded();

    await expect(provider.getPushEventSummary(ref)).resolves.toEqual(PUSH_EVENTS);
  });

  it("stops calling the forge for commit history once the circuit opens", async () => {
    const { provider, getCommitHistorySummary } = guarded({
      getCommitHistorySummary: vi.fn().mockRejectedValue(new Error("503 upstream"))
    });

    await trip(provider);
    getCommitHistorySummary.mockClear();

    await expect(provider.getCommitHistorySummary(ref)).rejects.toThrow(CircuitOpenError);
  });

  // Push events are best-effort by the provider contract: a forge with no
  // such API, or one that returns nothing, reports available: false rather
  // than throwing. A breaker refusal is that case - no data, for a reason
  // that isn't this repo's fault - so turning it into a throw would break
  // the contract every caller of this method relies on.
  it("reports push events as unavailable rather than throwing when the circuit is open", async () => {
    const { provider } = guarded({
      getCommitHistorySummary: vi.fn().mockRejectedValue(new Error("503 upstream"))
    });

    await trip(provider);

    await expect(provider.getPushEventSummary(ref)).resolves.toEqual({
      available: false,
      distinctPushDays: 0,
      maxSinglePushCommitShare: 0
    });
  });

  // Absorbing the refusal for push events would hide an outage if the
  // history call didn't fail too. It does, through the same breaker, so a
  // check against a forge that isn't answering still fails loudly instead
  // of quietly scoring the repo on three signals.
  it("still fails the check as a whole while the circuit is open", async () => {
    const { provider } = guarded({
      getCommitHistorySummary: vi.fn().mockRejectedValue(new Error("503 upstream"))
    });

    await trip(provider);

    await expect(provider.getCommitHistorySummary(ref)).rejects.toThrow(CircuitOpenError);
  });

  it("lets a real push-event failure propagate, absorbing only the refusal", async () => {
    const { provider } = guarded({
      getPushEventSummary: vi.fn().mockRejectedValue(new Error("events API exploded"))
    });

    await expect(provider.getPushEventSummary(ref)).rejects.toThrow("events API exploded");
  });

  it("goes back to calling the forge once it recovers", async () => {
    const getCommitHistorySummary = vi
      .fn()
      .mockRejectedValueOnce(new Error("503 upstream"))
      .mockRejectedValueOnce(new Error("503 upstream"))
      .mockResolvedValue(HISTORY);
    const breaker = new CircuitBreaker("GitHub", { failureThreshold: 2, openMs: 0 });
    const provider = new GuardedProvider(
      { id: "github", getCommitHistorySummary, getPushEventSummary: vi.fn() },
      breaker
    );

    await trip(provider);

    await expect(provider.getCommitHistorySummary(ref)).resolves.toEqual(HISTORY);
    expect(breaker.state()).toBe("closed");
  });
});
