import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROVIDER_ID,
  PROVIDER_HOSTS,
  PROVIDER_IDS,
  authenticatedCloneUrl,
  cloneUrlFor,
  describeRef,
  matchSshPrefix,
  providerHost,
  providerIdForHost
} from "../src/providers/hosts";

describe("providerIdForHost", () => {
  it("maps each provider's canonical host to its id", () => {
    for (const id of PROVIDER_IDS) {
      expect(providerIdForHost(PROVIDER_HOSTS[id].host)).toBe(id);
    }
  });

  it("accepts subdomains of a known host", () => {
    expect(providerIdForHost("www.github.com")).toBe("github");
    expect(providerIdForHost("www.gitlab.com")).toBe("gitlab");
  });

  it("is case-insensitive, since hostnames are", () => {
    expect(providerIdForHost("GitHub.COM")).toBe("github");
  });

  it("returns null for a host no provider serves", () => {
    expect(providerIdForHost("git.internal.test")).toBeNull();
    expect(providerIdForHost("example.com")).toBeNull();
  });

  it("rejects lookalike hosts rather than treating them as the real one", () => {
    // These are the SSRF cases: a host that merely contains or suffixes a
    // known host must not resolve to that provider.
    expect(providerIdForHost("notgithub.com")).toBeNull();
    expect(providerIdForHost("github.com.evil.test")).toBeNull();
    expect(providerIdForHost("github.com.")).toBeNull();
    expect(providerIdForHost("evil-github.com")).toBeNull();
  });
});

describe("matchSshPrefix", () => {
  it("splits a known ssh shorthand into provider and remainder", () => {
    expect(matchSshPrefix("git@github.com:octocat/hello.git")).toEqual({
      id: "github",
      rest: "octocat/hello.git"
    });
    expect(matchSshPrefix("git@bitbucket.org:octocat/hello")).toEqual({
      id: "bitbucket",
      rest: "octocat/hello"
    });
  });

  it("returns null for an ssh shorthand on an unknown host", () => {
    expect(matchSshPrefix("git@git.internal.test:octocat/hello.git")).toBeNull();
  });

  it("does not misalign the remainder when the input starts with a multi-byte character", () => {
    // Lowercasing can change a string's length for some characters, which
    // would shift the slice offset if the whole input were lowercased first.
    expect(matchSshPrefix("İgit@github.com:octocat/hello")).toBeNull();
  });
});

describe("cloneUrlFor", () => {
  it("always produces an https URL on the provider's canonical host", () => {
    for (const id of PROVIDER_IDS) {
      const url = cloneUrlFor({ provider: id, owner: "octocat", repo: "hello" });
      expect(url).toBe(`https://${PROVIDER_HOSTS[id].host}/octocat/hello.git`);
      expect(new URL(url).protocol).toBe("https:");
    }
  });
});

describe("authenticatedCloneUrl", () => {
  it("returns the plain clone URL when there is no token", () => {
    expect(authenticatedCloneUrl({ provider: "github", owner: "octocat", repo: "hello" })).toBe(
      "https://github.com/octocat/hello.git"
    );
  });

  it("uses each provider's own placeholder username for the token", () => {
    const users: Record<string, string> = {
      github: "x-access-token",
      gitlab: "oauth2",
      bitbucket: "x-token-auth"
    };
    for (const id of PROVIDER_IDS) {
      const url = new URL(
        authenticatedCloneUrl({ provider: id, owner: "octocat", repo: "hello" }, "secret")
      );
      expect(url.username).toBe(users[id]);
      expect(url.password).toBe("secret");
      expect(url.hostname).toBe(PROVIDER_HOSTS[id].host);
    }
  });

  it("percent-encodes the token so it cannot change the host", () => {
    const url = new URL(
      authenticatedCloneUrl(
        { provider: "github", owner: "octocat", repo: "hello" },
        "a@evil.test/b"
      )
    );
    expect(url.hostname).toBe("github.com");
    expect(decodeURIComponent(url.password)).toBe("a@evil.test/b");
  });
});

describe("describeRef", () => {
  it("renders host/owner/repo for logs and error messages", () => {
    expect(describeRef({ provider: "gitlab", owner: "octocat", repo: "hello" })).toBe(
      "gitlab.com/octocat/hello"
    );
  });
});

describe("provider host table", () => {
  it("defaults to github, the only provider with an implementation", () => {
    expect(DEFAULT_PROVIDER_ID).toBe("github");
  });

  it("keeps each spec's id in sync with its key", () => {
    for (const id of PROVIDER_IDS) {
      expect(providerHost(id).id).toBe(id);
    }
  });

  it("gives every provider a distinct host and an ssh prefix matching it", () => {
    const hosts = PROVIDER_IDS.map((id) => PROVIDER_HOSTS[id].host);
    expect(new Set(hosts).size).toBe(hosts.length);
    for (const id of PROVIDER_IDS) {
      expect(PROVIDER_HOSTS[id].sshPrefix).toBe(`git@${PROVIDER_HOSTS[id].host}:`);
    }
  });
});
