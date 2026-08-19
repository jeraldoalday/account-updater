import { describe, expect, it } from "vitest";
import {
  isGenericCommitMessage,
  normalizeCommitMessage,
  summarizeCommitMessages
} from "../src/analysis/commitMessagePatterns";

describe("normalizeCommitMessage", () => {
  it("trims whitespace, lowercases, and keeps only the first line", () => {
    expect(normalizeCommitMessage("  Fix Bug\n\nlonger body text")).toBe("fix bug");
  });
});

describe("isGenericCommitMessage", () => {
  it.each(["wip", "WIP", "fix", "fixed", "update", "commit 42", "Day 3", ".", "a", ""])(
    "flags %j as generic",
    (message) => {
      expect(isGenericCommitMessage(message)).toBe(true);
    }
  );

  it.each([
    "Add rate limiting to the eligibility endpoint",
    "Fix a race condition in the cache coalescing logic",
    "Refactor GitHubClient to sample commit authors"
  ])("does not flag %j as generic", (message) => {
    expect(isGenericCommitMessage(message)).toBe(false);
  });
});

describe("summarizeCommitMessages", () => {
  it("returns neutral stats for an empty sample", () => {
    expect(summarizeCommitMessages([])).toEqual({
      sampled: 0,
      distinctMessageRatio: 1,
      genericMessageShare: 0
    });
  });

  it("scores a varied, descriptive sample highly", () => {
    const stats = summarizeCommitMessages([
      "Add rate limiting to the eligibility endpoint",
      "Fix a race condition in the cache coalescing logic",
      "Refactor GitHubClient to sample commit authors",
      "Document the batch endpoint in the OpenAPI spec"
    ]);
    expect(stats.distinctMessageRatio).toBe(1);
    expect(stats.genericMessageShare).toBe(0);
  });

  it("scores a templated, low-variety sample poorly", () => {
    const stats = summarizeCommitMessages(["wip", "wip", "commit 1", "commit 2", "update", "fix"]);
    expect(stats.genericMessageShare).toBe(1);
    expect(stats.distinctMessageRatio).toBeLessThan(1);
  });

  it("treats repeated identical messages as low diversity even if descriptive", () => {
    const stats = summarizeCommitMessages(["Sync data", "Sync data", "Sync data", "Sync data"]);
    expect(stats.distinctMessageRatio).toBe(0.25);
    expect(stats.genericMessageShare).toBe(0);
  });
});
