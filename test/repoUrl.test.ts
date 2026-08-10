import { describe, expect, it } from "vitest";
import { parseRepoRef, cloneUrlFor } from "../src/utils/repoUrl";

describe("parseRepoRef", () => {
  it("parses owner/repo shorthand", () => {
    expect(parseRepoRef("octocat/hello-world")).toEqual({ owner: "octocat", repo: "hello-world" });
  });

  it("parses an https URL", () => {
    expect(parseRepoRef("https://github.com/octocat/hello-world")).toEqual({
      owner: "octocat",
      repo: "hello-world"
    });
  });

  it("parses an https URL with a .git suffix", () => {
    expect(parseRepoRef("https://github.com/octocat/hello-world.git")).toEqual({
      owner: "octocat",
      repo: "hello-world"
    });
  });

  it("parses an ssh URL", () => {
    expect(parseRepoRef("git@github.com:octocat/hello-world.git")).toEqual({
      owner: "octocat",
      repo: "hello-world"
    });
  });

  it("rejects non-GitHub hosts", () => {
    expect(() => parseRepoRef("https://gitlab.com/octocat/hello-world")).toThrow();
  });

  it("rejects garbage input", () => {
    expect(() => parseRepoRef("not a repo")).toThrow();
  });
});

describe("cloneUrlFor", () => {
  it("builds an https clone URL", () => {
    expect(cloneUrlFor({ owner: "octocat", repo: "hello-world" })).toBe(
      "https://github.com/octocat/hello-world.git"
    );
  });
});
