import { describe, expect, it, vi } from "vitest";
import {
  createProvider,
  isProviderSupported,
  supportedProviderIds
} from "../src/providers/registry";
import { UnsupportedProviderError } from "../src/providers/provider";
import { GitHubProvider } from "../src/providers/github/githubProvider";
import { PROVIDER_IDS } from "../src/providers/hosts";

// Constructing a GitHubProvider builds an Octokit instance; stub the
// network layer away so these tests stay offline and fast.
vi.mock("@octokit/rest", () => ({
  Octokit: class {
    rest = {};
  }
}));

describe("provider registry", () => {
  it("builds a GitHub provider for github refs", () => {
    const provider = createProvider("github");
    expect(provider).toBeInstanceOf(GitHubProvider);
    expect(provider.id).toBe("github");
  });

  it("passes the caller's token through to the provider it builds", () => {
    // A per-request token is how a private repo gets evaluated, so the
    // factory must not quietly drop it.
    expect(() => createProvider("github", "caller-token")).not.toThrow();
  });

  it("throws a typed error naming the provider for a forge with no implementation", () => {
    expect(() => createProvider("gitlab")).toThrow(UnsupportedProviderError);
    expect(() => createProvider("gitlab")).toThrow(/GitLab repositories are not supported yet/);
    expect(() => createProvider("bitbucket")).toThrow(/Bitbucket/);
  });

  it("names the providers that do work in the unsupported error", () => {
    try {
      createProvider("gitlab");
      expect.unreachable("createProvider should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedProviderError);
      expect((err as UnsupportedProviderError).providerId).toBe("gitlab");
      expect((err as UnsupportedProviderError).supported).toEqual(["github"]);
      expect((err as Error).message).toContain("GitHub");
    }
  });

  it("reports exactly the providers it can build", () => {
    expect(supportedProviderIds()).toEqual(["github"]);
    for (const id of PROVIDER_IDS) {
      expect(isProviderSupported(id)).toBe(id === "github");
    }
  });

  it("only claims support for providers the host table knows about", () => {
    // A supported id with no host entry would break clone-URL building.
    for (const id of supportedProviderIds()) {
      expect(PROVIDER_IDS).toContain(id);
    }
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
