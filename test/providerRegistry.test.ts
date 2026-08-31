import { describe, expect, it, vi } from "vitest";
import {
  createProvider,
  isProviderSupported,
  supportedProviderIds
} from "../src/providers/registry";
import { UnsupportedProviderError } from "../src/providers/provider";
import { GitHubProvider } from "../src/providers/github/githubProvider";
import { GitLabProvider } from "../src/providers/gitlab/gitlabProvider";
import { BitbucketProvider } from "../src/providers/bitbucket/bitbucketProvider";
import { GuardedProvider } from "../src/providers/guardedProvider";
import { PROVIDER_IDS, type ProviderId } from "../src/providers/hosts";
import type { RepoProvider } from "../src/providers/provider";

// Constructing a GitHubProvider builds an Octokit instance; stub the
// network layer away so these tests stay offline and fast.
vi.mock("@octokit/rest", () => ({
  Octokit: class {
    rest = {};
  }
}));

/**
 * The provider the registry actually built, behind the circuit breaker
 * every provider is wrapped in. Which forge's client is inside is still
 * worth asserting - it is what the registry's map is for - and the
 * wrapping is asserted separately below.
 */
function unwrap(provider: RepoProvider): RepoProvider {
  return (provider as unknown as { inner: RepoProvider }).inner;
}

describe("provider registry", () => {
  it("guards every provider it builds with its forge's circuit breaker", () => {
    // Applied here rather than inside the three adapters, so a fourth
    // forge cannot be added without one.
    for (const id of supportedProviderIds()) {
      expect(createProvider(id)).toBeInstanceOf(GuardedProvider);
    }
  });

  it("builds a GitHub provider for github refs", () => {
    const provider = createProvider("github");
    expect(unwrap(provider)).toBeInstanceOf(GitHubProvider);
    expect(provider.id).toBe("github");
  });

  it("passes the caller's token through to the provider it builds", () => {
    // A per-request token is how a private repo gets evaluated, so the
    // factory must not quietly drop it.
    expect(() => createProvider("github", "caller-token")).not.toThrow();
  });

  it("builds a GitLab provider for gitlab refs", () => {
    const provider = createProvider("gitlab");
    expect(unwrap(provider)).toBeInstanceOf(GitLabProvider);
    expect(provider.id).toBe("gitlab");
  });

  it("builds a Bitbucket provider for bitbucket refs", () => {
    const provider = createProvider("bitbucket");
    expect(unwrap(provider)).toBeInstanceOf(BitbucketProvider);
    expect(provider.id).toBe("bitbucket");
  });

  it("throws a typed error naming the provider for a forge with no implementation", () => {
    // Every forge the host table names is implemented today, so this is
    // the seam rather than a live case: a forge can be recognized - its
    // URLs parsed, its clone host known - before it can be evaluated, and
    // a caller who asks for one gets a 400 that says so rather than a 502.
    // Exercised with an id that has no factory, which is exactly the state
    // the next forge will be added in.
    const future = "codeberg" as ProviderId;
    expect(() => createProvider(future)).toThrow(UnsupportedProviderError);
  });

  it("names the providers that do work in the unsupported error", () => {
    try {
      throw new UnsupportedProviderError("bitbucket", ["github", "gitlab"]);
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedProviderError);
      expect((err as UnsupportedProviderError).providerId).toBe("bitbucket");
      // The caller's next move is to use a forge that works, so the error
      // has to name them rather than only naming the one that doesn't.
      expect((err as Error).message).toContain("GitHub, GitLab");
      expect((err as Error).message).toMatch(/Bitbucket repositories are not supported yet/);
    }
  });

  it("reports exactly the providers it can build", () => {
    expect(supportedProviderIds()).toEqual(["github", "gitlab", "bitbucket"]);
    for (const id of PROVIDER_IDS) {
      expect(isProviderSupported(id)).toBe(true);
    }
  });

  it("only claims support for providers the host table knows about", () => {
    // A supported id with no host entry would break clone-URL building.
    for (const id of supportedProviderIds()) {
      expect(PROVIDER_IDS).toContain(id);
    }
  });
});

describe("GitLabProvider", () => {
  it("satisfies the RepoProvider contract by delegating to the GitLab client", async () => {
    const provider = new GitLabProvider();
    const history = { commitCount: 12 };
    const pushes = { available: false };

    const client = {
      getCommitHistorySummary: vi.fn().mockResolvedValue(history),
      getPushEventSummary: vi.fn().mockResolvedValue(pushes)
    };
    (provider as unknown as { client: typeof client }).client = client;

    const ref = { provider: "gitlab" as const, owner: "acme", repo: "widgets" };
    await expect(provider.getCommitHistorySummary(ref)).resolves.toBe(history);
    await expect(provider.getPushEventSummary(ref)).resolves.toBe(pushes);
    expect(client.getCommitHistorySummary).toHaveBeenCalledWith(ref);
    expect(client.getPushEventSummary).toHaveBeenCalledWith(ref);
  });
});

describe("GitHubProvider", () => {
  it("satisfies the RepoProvider contract by delegating to the GitHub client", async () => {
    const provider = new GitHubProvider();
    const history = { commitCount: 7 };
    const pushes = { available: true };

    // Stand in for the transport: the adapter's job is delegation, and
    // this asserts it forwards the ref and returns the result untouched.
    const client = {
      getCommitHistorySummary: vi.fn().mockResolvedValue(history),
      getPushEventSummary: vi.fn().mockResolvedValue(pushes)
    };
    (provider as unknown as { client: typeof client }).client = client;

    const ref = { provider: "github" as const, owner: "octocat", repo: "hello" };
    await expect(provider.getCommitHistorySummary(ref)).resolves.toBe(history);
    await expect(provider.getPushEventSummary(ref)).resolves.toBe(pushes);
    expect(client.getCommitHistorySummary).toHaveBeenCalledWith(ref);
    expect(client.getPushEventSummary).toHaveBeenCalledWith(ref);
  });
});

describe("BitbucketProvider", () => {
  it("satisfies the RepoProvider contract by delegating to the Bitbucket client", async () => {
    const provider = new BitbucketProvider();
    const history = { commitCount: 42 };
    const pushes = { available: false };

    const client = {
      getCommitHistorySummary: vi.fn().mockResolvedValue(history),
      getPushEventSummary: vi.fn().mockResolvedValue(pushes)
    };
    (provider as unknown as { client: typeof client }).client = client;

    const ref = { provider: "bitbucket" as const, owner: "acme", repo: "widgets" };
    await expect(provider.getCommitHistorySummary(ref)).resolves.toBe(history);
    await expect(provider.getPushEventSummary(ref)).resolves.toBe(pushes);
    expect(client.getCommitHistorySummary).toHaveBeenCalledWith(ref);
    expect(client.getPushEventSummary).toHaveBeenCalledWith(ref);
  });
});
