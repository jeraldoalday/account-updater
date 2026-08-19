import { describe, expect, it } from "vitest";
import { parseRepoRef, cloneUrlFor } from "../src/utils/repoUrl";

describe("parseRepoRef", () => {
  it("parses owner/repo shorthand", () => {
    expect(parseRepoRef("octocat/hello-world")).toEqual({
      provider: "github",
      owner: "octocat",
      repo: "hello-world"
    });
  });

  it("parses an https URL", () => {
    expect(parseRepoRef("https://github.com/octocat/hello-world")).toEqual({
      provider: "github",
      owner: "octocat",
      repo: "hello-world"
    });
  });

  it("parses an https URL with a .git suffix", () => {
    expect(parseRepoRef("https://github.com/octocat/hello-world.git")).toEqual({
      provider: "github",
      owner: "octocat",
      repo: "hello-world"
    });
  });

  it("parses an ssh URL", () => {
    expect(parseRepoRef("git@github.com:octocat/hello-world.git")).toEqual({
      provider: "github",
      owner: "octocat",
      repo: "hello-world"
    });
  });

  // Parsing a provider is deliberately not the same as supporting it: these
  // refs parse, and the provider registry is what rejects them (with a
  // message that explains why) when an evaluation is attempted.
  it("parses a GitLab https URL as the gitlab provider", () => {
    expect(parseRepoRef("https://gitlab.com/octocat/hello-world")).toEqual({
      provider: "gitlab",
      owner: "octocat",
      repo: "hello-world"
    });
  });

  it("parses a Bitbucket ssh URL as the bitbucket provider", () => {
    expect(parseRepoRef("git@bitbucket.org:octocat/hello-world.git")).toEqual({
      provider: "bitbucket",
      owner: "octocat",
      repo: "hello-world"
    });
  });

  it("assumes the default provider for bare owner/repo shorthand", () => {
    expect(parseRepoRef("octocat/hello-world").provider).toBe("github");
  });

  it("rejects a host that belongs to no known provider", () => {
    expect(() => parseRepoRef("https://git.internal.test/octocat/hello-world")).toThrow(
      /Unsupported host/
    );
  });

  it("rejects garbage input", () => {
    expect(() => parseRepoRef("not a repo")).toThrow();
  });

  describe("SSRF guards", () => {
    it("rejects a host that merely ends with github.com as a suffix", () => {
      expect(() => parseRepoRef("https://notgithub.com/octocat/hello-world")).toThrow();
    });

    it("rejects a host that embeds github.com as a subdomain of another domain", () => {
      expect(() => parseRepoRef("https://github.com.evil.com/octocat/hello-world")).toThrow();
    });

    it("rejects userinfo used to smuggle a real host past a github.com-looking prefix", () => {
      expect(() => parseRepoRef("https://github.com@evil.com/octocat/hello-world")).toThrow();
    });

    it("rejects userinfo even when the real host is github.com", () => {
      expect(() => parseRepoRef("https://user:pass@github.com/octocat/hello-world")).toThrow();
    });

    it("rejects non-https schemes", () => {
      expect(() => parseRepoRef("http://github.com/octocat/hello-world")).toThrow();
      expect(() => parseRepoRef("ftp://github.com/octocat/hello-world")).toThrow();
      expect(() => parseRepoRef("file:///etc/passwd")).toThrow();
    });

    it("rejects a trailing dot used to bypass suffix matching", () => {
      expect(() => parseRepoRef("https://github.com./octocat/hello-world")).toThrow();
    });

    it("rejects an owner/repo containing path-traversal segments", () => {
      expect(() => parseRepoRef("../../etc/passwd")).toThrow();
    });

    it("rejects a repo name of exactly '.' or '..'", () => {
      expect(() => parseRepoRef("https://github.com/octocat/.")).toThrow();
      expect(() => parseRepoRef("https://github.com/octocat/..")).toThrow();
    });

    it("rejects an owner with invalid characters", () => {
      expect(() => parseRepoRef("octo cat/hello-world")).toThrow();
      expect(() => parseRepoRef("-octocat/hello-world")).toThrow();
      expect(() => parseRepoRef("octocat-/hello-world")).toThrow();
    });

    it("rejects an owner longer than GitHub's 39-character limit", () => {
      const longOwner = "a".repeat(40);
      expect(() => parseRepoRef(`${longOwner}/hello-world`)).toThrow();
    });

    it("still parses a legitimate github.com subdomain form the same as the bare host", () => {
      expect(parseRepoRef("https://github.com/octocat/hello-world")).toEqual({
        provider: "github",
        owner: "octocat",
        repo: "hello-world"
      });
    });
  });
});

describe("cloneUrlFor", () => {
  it("builds an https clone URL", () => {
    expect(cloneUrlFor({ provider: "github", owner: "octocat", repo: "hello-world" })).toBe(
      "https://github.com/octocat/hello-world.git"
    );
  });

  it("builds the clone URL from the ref's provider host", () => {
    expect(cloneUrlFor({ provider: "gitlab", owner: "octocat", repo: "hello-world" })).toBe(
      "https://gitlab.com/octocat/hello-world.git"
    );
    expect(cloneUrlFor({ provider: "bitbucket", owner: "octocat", repo: "hello-world" })).toBe(
      "https://bitbucket.org/octocat/hello-world.git"
    );
  });
});
