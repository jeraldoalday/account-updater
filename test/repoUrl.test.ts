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

  it("keeps a GitLab subgroup in the namespace instead of reading it as the project", () => {
    // The bug this closes: with the GitHub rule ("owner is the first
    // segment, project is the second"), this URL evaluated the *group*
    // gitlab.com/acme/platform as if it were the project - a different
    // thing than the caller asked about, and usually a 404.
    expect(parseRepoRef("https://gitlab.com/acme/platform/widgets")).toEqual({
      provider: "gitlab",
      owner: "acme/platform",
      repo: "widgets"
    });
  });

  it("parses a deeply nested GitLab project", () => {
    expect(parseRepoRef("https://gitlab.com/acme/platform/team/widgets.git")).toEqual({
      provider: "gitlab",
      owner: "acme/platform/team",
      repo: "widgets"
    });
  });

  it("stops at GitLab's /-/ separator, which marks a page within the project", () => {
    // This is the URL shape a caller actually copies out of the browser.
    expect(parseRepoRef("https://gitlab.com/acme/platform/widgets/-/tree/main")).toEqual({
      provider: "gitlab",
      owner: "acme/platform",
      repo: "widgets"
    });
  });

  it("parses a nested GitLab project from an ssh URL too", () => {
    expect(parseRepoRef("git@gitlab.com:acme/platform/widgets.git")).toEqual({
      provider: "gitlab",
      owner: "acme/platform",
      repo: "widgets"
    });
  });

  it("allows the dots and underscores GitLab group paths really contain", () => {
    expect(parseRepoRef("https://gitlab.com/acme.io/sub_group/widgets")).toEqual({
      provider: "gitlab",
      owner: "acme.io/sub_group",
      repo: "widgets"
    });
  });

  it("rejects a traversal segment in the ssh form, which nothing normalizes", () => {
    // Nesting widens what a namespace may contain, so the traversal guard
    // has to be applied per segment rather than to the joined string. The
    // ssh form is where it earns its keep: unlike an https URL, nothing
    // has already collapsed ".." out of the path by the time it arrives.
    expect(() => parseRepoRef("git@gitlab.com:acme/../evil/widgets.git")).toThrow();
    expect(() => parseRepoRef("git@gitlab.com:acme/./widgets.git")).toThrow();
  });

  it("rejects a namespace segment that does not start alphanumeric", () => {
    expect(() => parseRepoRef("https://gitlab.com/-evil/widgets")).toThrow();
    expect(() => parseRepoRef("https://gitlab.com/acme/-evil/widgets")).toThrow();
  });

  it("resolves a traversal in an https URL rather than parsing the dots", () => {
    // WHATWG URL parsing collapses these before we see them, so the result
    // is an ordinary ref for the path that was actually named - worth
    // pinning, because it looks like the guard above is what rejected it.
    expect(parseRepoRef("https://gitlab.com/acme/../platform/widgets")).toEqual({
      provider: "gitlab",
      owner: "platform",
      repo: "widgets"
    });
  });

  it("rejects a namespace nested past GitLab's own depth limit", () => {
    const tooDeep = Array.from({ length: 25 }, (_, i) => `g${i}`).join("/");
    expect(() => parseRepoRef(`https://gitlab.com/${tooDeep}/widgets`)).toThrow();
  });

  it("still reads extra GitHub path segments as a page, not as a namespace", () => {
    // GitHub has no nested owners, so /tree/main is a view of the repo.
    expect(parseRepoRef("https://github.com/octocat/hello-world/tree/main")).toEqual({
      provider: "github",
      owner: "octocat",
      repo: "hello-world"
    });
  });

  it("rejects a three-part shorthand, which names no provider that allows nesting", () => {
    // Bare shorthand means the default provider, and GitHub has no
    // subgroups - guessing GitLab from the shape would be worse than
    // asking for a URL.
    expect(() => parseRepoRef("acme/platform/widgets")).toThrow();
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
