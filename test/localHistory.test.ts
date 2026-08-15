import { describe, expect, it } from "vitest";
import { buildLocalHistorySummary } from "../src/cli/localHistory";

describe("buildLocalHistorySummary", () => {
  it("returns zeroed-out fields for no commits", () => {
    const summary = buildLocalHistorySummary([]);
    expect(summary.commitCount).toBe(0);
    expect(summary.firstCommitDate).toBeNull();
    expect(summary.lastCommitDate).toBeNull();
    expect(summary.historyDays).toBe(0);
    expect(summary.truncated).toBe(false);
  });

  it("derives first/last commit date and history span from unsorted input", () => {
    const summary = buildLocalHistorySummary([
      { date: "2026-01-10T00:00:00Z", authorKey: "a", message: "Third" },
      { date: "2026-01-01T00:00:00Z", authorKey: "a", message: "First" },
      { date: "2026-01-05T00:00:00Z", authorKey: "a", message: "Second" }
    ]);
    expect(summary.firstCommitDate).toBe("2026-01-01T00:00:00Z");
    expect(summary.lastCommitDate).toBe("2026-01-10T00:00:00Z");
    expect(summary.historyDays).toBe(9);
    expect(summary.commitCount).toBe(3);
  });

  it("passes author and message stats through from summarizeCommitSample", () => {
    const summary = buildLocalHistorySummary([
      { date: "2026-01-01T00:00:00Z", authorKey: "alice", message: "wip" },
      { date: "2026-01-02T00:00:00Z", authorKey: "bob", message: "Add feature X" }
    ]);
    expect(summary.authorStats.distinctAuthors).toBe(2);
    expect(summary.messageStats.genericMessageShare).toBe(0.5);
  });
});
