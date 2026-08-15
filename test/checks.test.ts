import { describe, expect, it } from "vitest";
import { checkLanguage } from "../src/eligibility/checks/language";
import { checkSize } from "../src/eligibility/checks/size";
import { checkHistory } from "../src/eligibility/checks/history";
import { checkActiveDevelopment } from "../src/eligibility/checks/activity";
import type { CommitHistorySummary, PushEventSummary, SourceScanResult } from "../src/types";

function scan(overrides: Partial<SourceScanResult> = {}): SourceScanResult {
  return {
    byLanguage: [{ language: "TypeScript", lines: 9000, files: 60 }],
    totalLines: 9000,
    totalFiles: 60,
    primaryLanguage: "TypeScript",
    ...overrides
  };
}

function history(overrides: Partial<CommitHistorySummary> = {}): CommitHistorySummary {
  return {
    commitCount: 150,
    firstCommitDate: "2026-01-01T00:00:00Z",
    lastCommitDate: "2026-01-20T00:00:00Z",
    historyDays: 19,
    commitsByDay: {},
    distinctCommitDays: 12,
    maxSingleDayCommitShare: 0.2,
    authorStats: { sampled: 150, distinctAuthors: 3, maxAuthorShare: 0.5 },
    messageStats: { sampled: 150, distinctMessageRatio: 0.9, genericMessageShare: 0.05 },
    truncated: false,
    ...overrides
  };
}

function pushEvents(overrides: Partial<PushEventSummary> = {}): PushEventSummary {
  return { available: true, distinctPushDays: 10, maxSinglePushCommitShare: 0.2, ...overrides };
}

describe("checkLanguage", () => {
  it("passes for an allowed language", () => {
    expect(checkLanguage(scan()).passed).toBe(true);
  });

  it("fails for a disallowed primary language", () => {
    const result = checkLanguage(scan({ primaryLanguage: "Ruby" }));
    expect(result.passed).toBe(false);
    expect(result.reasons[0]).toMatch(/not one of the eligible languages/);
  });

  it("fails when no source files are found", () => {
    const result = checkLanguage(scan({ primaryLanguage: null }));
    expect(result.passed).toBe(false);
  });
});

describe("checkSize", () => {
  it("passes when both thresholds are met", () => {
    expect(checkSize(scan()).passed).toBe(true);
  });

  it("fails when lines are too low", () => {
    const result = checkSize(scan({ totalLines: 500 }));
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes("lines"))).toBe(true);
  });

  it("fails when file count is too low", () => {
    const result = checkSize(scan({ totalFiles: 3 }));
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes("files"))).toBe(true);
  });
});

describe("checkHistory", () => {
  it("passes with enough commits and span", () => {
    expect(checkHistory(history()).passed).toBe(true);
  });

  it("fails with too few commits", () => {
    const result = checkHistory(history({ commitCount: 10 }));
    expect(result.passed).toBe(false);
  });

  it("fails when history is too short", () => {
    const result = checkHistory(history({ historyDays: 2 }));
    expect(result.passed).toBe(false);
  });
});

describe("checkActiveDevelopment", () => {
  it("passes for a spread-out, organically pushed history", () => {
    expect(checkActiveDevelopment(history(), pushEvents()).passed).toBe(true);
  });

  it("fails when commits cluster on very few days", () => {
    const result = checkActiveDevelopment(
      history({ distinctCommitDays: 2, maxSingleDayCommitShare: 0.9 }),
      pushEvents()
    );
    expect(result.passed).toBe(false);
  });

  it("fails when a single push event delivers almost everything at once", () => {
    const result = checkActiveDevelopment(
      history(),
      pushEvents({ maxSinglePushCommitShare: 0.95 })
    );
    expect(result.passed).toBe(false);
  });

  it("does not fail on push-event data alone when events are unavailable", () => {
    const result = checkActiveDevelopment(
      history(),
      pushEvents({ available: false, maxSinglePushCommitShare: 1 })
    );
    expect(result.passed).toBe(true);
  });

  it("exposes a numeric score alongside the pass/fail verdict", () => {
    const result = checkActiveDevelopment(history(), pushEvents());
    expect(result.score).toBeGreaterThan(0.9);
    expect(result.score).toBeLessThanOrEqual(1);
  });

  it("does not fail a single-maintainer repo on contributor diversity alone", () => {
    const result = checkActiveDevelopment(
      history({ authorStats: { sampled: 150, distinctAuthors: 1, maxAuthorShare: 1 } }),
      pushEvents()
    );
    expect(result.passed).toBe(true);
  });

  it("fails when commit messages are almost entirely generic/templated", () => {
    const result = checkActiveDevelopment(
      history({
        distinctCommitDays: 8,
        maxSingleDayCommitShare: 0.6,
        authorStats: { sampled: 150, distinctAuthors: 1, maxAuthorShare: 1 },
        messageStats: { sampled: 150, distinctMessageRatio: 0.02, genericMessageShare: 0.98 }
      }),
      pushEvents({ available: false, maxSinglePushCommitShare: 0 })
    );
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes("generic/templated"))).toBe(true);
  });

  it("still fails a near-total single-push dump even with otherwise strong signals", () => {
    const result = checkActiveDevelopment(history(), pushEvents({ maxSinglePushCommitShare: 0.95 }));
    expect(result.passed).toBe(false);
  });
});
