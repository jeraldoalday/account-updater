import { beforeEach, describe, expect, it, vi } from "vitest";
import { openHistoryDb } from "../src/history/db";
import { HistoryStore } from "../src/history/historyStore";
import { cutoffFor, startRetentionSweeper } from "../src/history/retention";

function seed(store: HistoryStore, evaluatedAt: string, repo = "r"): void {
  const db = (store as unknown as { db: import("better-sqlite3").Database }).db;
  db.prepare(
    `INSERT INTO evaluations (provider, owner, repo, evaluated_at, eligible, reasons)
     VALUES ('github', 'acme', ?, ?, 1, '[]')`
  ).run(repo, evaluatedAt);
}

const NOW = new Date("2026-08-20T12:00:00.000Z");
const now = () => NOW;

describe("cutoffFor", () => {
  it("is the retention window before now", () => {
    expect(cutoffFor(NOW, 90)).toBe("2026-05-22T12:00:00.000Z");
  });

  it("handles a one-day window", () => {
    expect(cutoffFor(NOW, 1)).toBe("2026-08-19T12:00:00.000Z");
  });
});

describe("HistoryStore.prune", () => {
  let store: HistoryStore;

  beforeEach(() => {
    store = new HistoryStore(openHistoryDb(":memory:"));
  });

  it("deletes rows older than the cutoff and keeps the rest", () => {
    seed(store, "2026-01-01T00:00:00.000Z", "ancient");
    seed(store, "2026-08-19T00:00:00.000Z", "recent");

    expect(store.prune("2026-08-01T00:00:00.000Z")).toBe(1);
    expect(store.list().map((r) => r.repo.repo)).toEqual(["recent"]);
  });

  it("keeps a row exactly at the cutoff, since the bound is exclusive", () => {
    seed(store, "2026-08-01T00:00:00.000Z", "boundary");

    expect(store.prune("2026-08-01T00:00:00.000Z")).toBe(0);
    expect(store.list()).toHaveLength(1);
  });

  it("normalizes a cutoff given in another timezone", () => {
    seed(store, "2026-08-01T09:00:00.000Z", "morning");

    // 12:00+05:00 is 07:00Z, which is before the row - so nothing goes.
    expect(store.prune("2026-08-01T12:00:00+05:00")).toBe(0);
    expect(store.prune("2026-08-01T12:00:00+01:00")).toBe(1);
  });

  it("rejects an unparseable cutoff rather than deleting on a guess", () => {
    seed(store, "2026-08-01T00:00:00.000Z");

    expect(() => store.prune("last tuesday")).toThrow(/Invalid timestamp/);
    expect(store.list()).toHaveLength(1);
  });

  it("reports the oldest row still stored, and nothing when empty", () => {
    expect(store.oldestEvaluatedAt()).toBeUndefined();

    seed(store, "2026-03-03T00:00:00.000Z");
    seed(store, "2026-08-03T00:00:00.000Z");

    expect(store.oldestEvaluatedAt()).toBe("2026-03-03T00:00:00.000Z");
  });
});

describe("startRetentionSweeper", () => {
  let store: HistoryStore;
  const log = vi.fn();

  beforeEach(() => {
    store = new HistoryStore(openHistoryDb(":memory:"));
    log.mockReset();
  });

  function start(retentionDays: number, overrides = {}) {
    return startRetentionSweeper({
      store,
      retentionDays,
      intervalMs: 60_000,
      now,
      log,
      setInterval: vi.fn(() => ({ unref: vi.fn() })) as unknown as typeof setInterval,
      clearInterval: vi.fn() as unknown as typeof clearInterval,
      ...overrides
    });
  }

  it("sweeps once immediately, so a restart doesn't wait out the interval", () => {
    seed(store, "2026-01-01T00:00:00.000Z");

    start(90);

    expect(store.list()).toHaveLength(0);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "history_pruned", deleted: 1, retentionDays: 90 })
    );
  });

  it("says nothing on a sweep that deleted nothing", () => {
    seed(store, "2026-08-19T00:00:00.000Z");

    start(90);

    expect(store.list()).toHaveLength(1);
    expect(log).not.toHaveBeenCalledWith(expect.objectContaining({ msg: "history_pruned" }));
  });

  it("schedules repeat sweeps on the configured interval, unref'd", () => {
    const unref = vi.fn();
    const schedule = vi.fn(() => ({ unref })) as unknown as typeof setInterval;

    start(90, { setInterval: schedule });

    expect(schedule).toHaveBeenCalledWith(expect.any(Function), 60_000);
    // A pending sweep must never be what keeps the process alive after the
    // server has closed.
    expect(unref).toHaveBeenCalled();
  });

  it("prunes again when the scheduled sweep fires", () => {
    let scheduled: (() => void) | undefined;
    const schedule = vi.fn((fn: () => void) => {
      scheduled = fn;
      return { unref: vi.fn() };
    }) as unknown as typeof setInterval;

    start(90, { setInterval: schedule });
    seed(store, "2026-01-01T00:00:00.000Z");
    scheduled?.();

    expect(store.list()).toHaveLength(0);
  });

  it("does nothing at all when retention is disabled", () => {
    seed(store, "2020-01-01T00:00:00.000Z");
    const schedule = vi.fn() as unknown as typeof setInterval;

    const sweeper = start(0, { setInterval: schedule });

    expect(store.list()).toHaveLength(1);
    expect(schedule).not.toHaveBeenCalled();
    expect(sweeper.sweep()).toBe(0);
    expect(log).toHaveBeenCalledWith({ msg: "history_retention_disabled" });
  });

  it("logs and survives a sweep that fails", () => {
    const broken = {
      prune: () => {
        throw new Error("database is locked");
      }
    } as unknown as HistoryStore;

    // A deletion that didn't happen is a disk-space problem to notice, not
    // a reason to take the service down.
    expect(() => start(90, { store: broken })).not.toThrow();
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "history_prune_failed", error: "database is locked" })
    );
  });

  it("stops the timer when the process shuts down", () => {
    const unschedule = vi.fn() as unknown as typeof clearInterval;
    const timer = { unref: vi.fn() };

    const sweeper = start(90, {
      setInterval: vi.fn(() => timer) as unknown as typeof setInterval,
      clearInterval: unschedule
    });
    sweeper.stop();

    expect(unschedule).toHaveBeenCalledWith(timer);
  });
});
