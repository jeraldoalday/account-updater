import type { HistoryStore } from "./historyStore";

export interface RetentionOptions {
  store: HistoryStore;
  /** Rows older than this many days are deleted. 0 disables pruning. */
  retentionDays: number;
  /** How often to sweep. A sweep also runs immediately on start. */
  intervalMs: number;
  now?: () => Date;
  log?: (event: Record<string, unknown>) => void;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
}

export interface RetentionSweeper {
  /** Runs one sweep now; exported so startup can prune before serving. */
  sweep: () => number;
  stop: () => void;
}

export function cutoffFor(now: Date, retentionDays: number): string {
  return new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Keeps the SQLite audit trail bounded by age.
 *
 * The trail exists to answer "what did we decide about this repo, and
 * when" - a question with a shelf life. Without a sweep it is an
 * append-only file that grows for as long as the process runs, and the
 * first anyone hears about it is a full disk taking down the endpoint
 * whose writes were supposed to be best-effort.
 *
 * A failed sweep is logged and swallowed: a deletion that didn't happen is
 * a disk-space problem to notice, not a reason to bring the service down.
 */
export function startRetentionSweeper(options: RetentionOptions): RetentionSweeper {
  const {
    store,
    retentionDays,
    intervalMs,
    now = () => new Date(),
    log = () => {},
    setInterval: schedule = setInterval,
    clearInterval: unschedule = clearInterval
  } = options;

  if (retentionDays <= 0) {
    log({ msg: "history_retention_disabled" });
    return { sweep: () => 0, stop: () => {} };
  }

  const sweep = (): number => {
    const cutoff = cutoffFor(now(), retentionDays);
    try {
      const deleted = store.prune(cutoff);
      if (deleted > 0) {
        log({ msg: "history_pruned", deleted, cutoff, retentionDays });
      }
      return deleted;
    } catch (err) {
      log({ msg: "history_prune_failed", cutoff, error: (err as Error).message });
      return 0;
    }
  };

  sweep();

  // Unref'd: a pending sweep must never be the reason the process stays
  // alive after the server has closed.
  const timer = schedule(sweep, intervalMs);
  timer.unref?.();

  return { sweep, stop: () => unschedule(timer) };
}
