export interface FailureReasonCount {
  /** The reason with its varying parts replaced, e.g. "Only N lines ...". */
  reason: string;
  count: number;
  /** One verbatim reason that was folded into this group. */
  example: string;
}

/**
 * Folds a reason down to the shape it shares with every other occurrence
 * of the same failure.
 *
 * Reasons are written for a human reading one result, so they carry the
 * specifics: "Only 12 lines of first-party source found (need at least
 * 500)." Counted verbatim across an audit trail, that makes every repo its
 * own unique failure and the tally says nothing. Replacing the numbers and
 * quoted values turns them back into the handful of categories they
 * actually are, which is the question a summary is asked: what do repos
 * fail on, and how often.
 */
export function normalizeReason(reason: string): string {
  return reason
    .replace(/"[^"]*"/g, '"…"')
    .replace(/\d+(?:\.\d+)?%?/g, "N")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Counts normalized reasons across evaluations, most common first, keeping
 * one verbatim example per group so the reader can see what the
 * placeholders stood for. Ties break alphabetically so the output is
 * stable between calls on identical data.
 */
export function topFailureReasons(
  reasonLists: readonly (readonly string[])[],
  topN: number
): FailureReasonCount[] {
  const groups = new Map<string, FailureReasonCount>();

  for (const reasons of reasonLists) {
    for (const reason of reasons) {
      const key = normalizeReason(reason);
      const existing = groups.get(key);
      if (existing) {
        existing.count++;
      } else {
        groups.set(key, { reason: key, count: 1, example: reason });
      }
    }
  }

  return [...groups.values()]
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
    .slice(0, topN);
}
