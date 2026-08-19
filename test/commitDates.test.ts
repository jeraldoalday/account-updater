import { describe, expect, it } from "vitest";
import { historySpanDays, parseCommitDate, sanitizeCommitDate } from "../src/analysis/commitDates";

describe("parseCommitDate", () => {
  it("parses a real ISO-8601 timestamp", () => {
    expect(parseCommitDate("2026-01-20T00:00:00Z")?.toISOString()).toBe("2026-01-20T00:00:00.000Z");
  });

  it("returns null for missing or unparseable values", () => {
    expect(parseCommitDate(null)).toBeNull();
    expect(parseCommitDate(undefined)).toBeNull();
    expect(parseCommitDate("")).toBeNull();
    expect(parseCommitDate("not-a-date")).toBeNull();
    expect(parseCommitDate("2026-13-45T99:99:99Z")).toBeNull();
  });

  it("rejects junk that V8's lenient Date parser would otherwise accept", () => {
    // new Date("garbage-1") is January 2001 and new Date("garbage-2") is
    // February 2001, so a Date-validity check alone would turn junk into
    // two distinct, real-looking commit days.
    expect(parseCommitDate("garbage-1")).toBeNull();
    expect(parseCommitDate("garbage-2")).toBeNull();
    expect(parseCommitDate("Jan 2001")).toBeNull();
  });

  it("accepts the ISO-8601 shapes git and the GitHub API actually emit", () => {
    expect(parseCommitDate("2026-01-20T00:00:00Z")).not.toBeNull();
    expect(parseCommitDate("2026-01-20T08:30:00+08:00")).not.toBeNull();
    expect(parseCommitDate("2026-01-20T08:30:00.123Z")).not.toBeNull();
    expect(parseCommitDate("2026-01-20")).not.toBeNull();
  });
});

describe("sanitizeCommitDate", () => {
  it("passes a valid date through unchanged", () => {
    expect(sanitizeCommitDate("2026-01-20T00:00:00Z")).toBe("2026-01-20T00:00:00Z");
  });

  it("replaces an unparseable date with null", () => {
    expect(sanitizeCommitDate("garbage")).toBeNull();
    expect(sanitizeCommitDate(undefined)).toBeNull();
  });
});

describe("historySpanDays", () => {
  it("counts whole days between the first and last commit", () => {
    expect(historySpanDays("2026-01-01T00:00:00Z", "2026-01-20T00:00:00Z")).toBe(19);
  });

  it("is 0 for a single-commit repo", () => {
    expect(historySpanDays("2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z")).toBe(0);
  });

  it("is 0, not NaN, when either date is unparseable", () => {
    // The regression this guards: NaN fails *both* `< threshold` and
    // `>= threshold`, so a NaN span silently satisfied the minimum-history
    // requirement instead of failing it.
    const span = historySpanDays("not-a-date", "2026-01-20T00:00:00Z");
    expect(span).toBe(0);
    expect(Number.isNaN(span)).toBe(false);
    expect(historySpanDays("2026-01-01T00:00:00Z", "also-not-a-date")).toBe(0);
    expect(historySpanDays("nope", "nope")).toBe(0);
  });

  it("is 0 when either date is missing", () => {
    expect(historySpanDays(null, "2026-01-20T00:00:00Z")).toBe(0);
    expect(historySpanDays("2026-01-01T00:00:00Z", null)).toBe(0);
    expect(historySpanDays(null, null)).toBe(0);
  });

  it("floors at 0 when the dates arrive out of order", () => {
    // A backdated or rewritten commit can carry an author date newer than
    // the repo's newest commit; a negative span is not a meaningful value.
    expect(historySpanDays("2026-01-20T00:00:00Z", "2026-01-01T00:00:00Z")).toBe(0);
  });
});
