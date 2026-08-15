import { describe, expect, it } from "vitest";
import { summarizeCommitSample } from "../src/analysis/commitSample";

describe("summarizeCommitSample", () => {
  it("returns zeroed-out stats for an empty sample", () => {
    const summary = summarizeCommitSample([]);
    expect(summary.sampled).toBe(0);
    expect(summary.distinctCommitDays).toBe(0);
    expect(summary.maxSingleDayCommitShare).toBe(0);
    expect(summary.authorStats).toEqual({ sampled: 0, distinctAuthors: 0, maxAuthorShare: 0 });
  });

  it("skips commits with no date but still counts them for author/message stats", () => {
    const summary = summarizeCommitSample([
      { date: null, authorKey: "a@example.com", message: "Add feature" }
    ]);
    expect(summary.sampled).toBe(0);
    expect(summary.authorStats.sampled).toBe(1);
  });

  it("builds a day histogram and flags a dominant single day", () => {
    const summary = summarizeCommitSample([
      { date: "2026-01-01T10:00:00Z", authorKey: "a", message: "One" },
      { date: "2026-01-01T11:00:00Z", authorKey: "a", message: "Two" },
      { date: "2026-01-01T12:00:00Z", authorKey: "a", message: "Three" },
      { date: "2026-01-02T09:00:00Z", authorKey: "a", message: "Four" }
    ]);
    expect(summary.distinctCommitDays).toBe(2);
    expect(summary.maxSingleDayCommitShare).toBe(0.75);
  });

  it("tracks author diversity independently of the day histogram", () => {
    const summary = summarizeCommitSample([
      { date: "2026-01-01T00:00:00Z", authorKey: "alice@example.com", message: "One" },
      { date: "2026-01-02T00:00:00Z", authorKey: "bob@example.com", message: "Two" },
      { date: "2026-01-03T00:00:00Z", authorKey: "alice@example.com", message: "Three" }
    ]);
    expect(summary.authorStats.distinctAuthors).toBe(2);
    expect(summary.authorStats.maxAuthorShare).toBeCloseTo(2 / 3);
  });

  it("treats a missing author identity as unknown rather than a distinct author", () => {
    const summary = summarizeCommitSample([
      { date: "2026-01-01T00:00:00Z", authorKey: null, message: "One" },
      { date: "2026-01-02T00:00:00Z", authorKey: null, message: "Two" }
    ]);
    expect(summary.authorStats).toEqual({ sampled: 0, distinctAuthors: 0, maxAuthorShare: 0 });
  });

  it("delegates message stats to summarizeCommitMessages", () => {
    const summary = summarizeCommitSample([
      { date: "2026-01-01T00:00:00Z", authorKey: "a", message: "wip" },
      { date: "2026-01-02T00:00:00Z", authorKey: "a", message: "wip" }
    ]);
    expect(summary.messageStats.genericMessageShare).toBe(1);
    expect(summary.messageStats.distinctMessageRatio).toBe(0.5);
  });
});
