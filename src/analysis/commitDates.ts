/**
 * Commit timestamps come from a provider API, and ultimately from whatever
 * a client wrote into the commit object, so they are not guaranteed to be
 * parseable dates. Treating an unparseable one as a real date is worse than
 * dropping it: `new Date("garbage").getTime()` is NaN, and NaN propagates
 * silently through arithmetic *and* through comparisons - `NaN < 5` and
 * `NaN >= 5` are both false, so a threshold check on a NaN span passes
 * instead of failing. These helpers keep that value out of the checks.
 */

/**
 * ISO-8601, which is what `git log --pretty=%aI` and every provider API
 * this service reads emit: a calendar date, optionally followed by a time
 * and a zone. Note the zone really does vary - GitHub sends "Z", Bitbucket
 * sends "+00:00" - so the offset forms are not hypothetical.
 *
 * Matching this explicitly matters, because `new Date()` alone is not a
 * validity test - V8's fallback parser accepts strings like "garbage-1"
 * and "garbage-2" and turns them into January and February 2001. Relying
 * on it would let junk timestamps become real, *distinct* commit days,
 * which is precisely the signal the organic-development score rewards.
 */
const ISO_8601 =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/** The date if it is a real ISO-8601 timestamp, otherwise null. */
export function parseCommitDate(value: string | null | undefined): Date | null {
  if (!value || !ISO_8601.test(value)) return null;
  // The shape can be right while the value is still impossible
  // ("2026-13-45"), so the parse result is checked too.
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** The original string if it parses as a date, otherwise null. */
export function sanitizeCommitDate(value: string | null | undefined): string | null {
  return parseCommitDate(value) === null ? null : (value as string);
}

const MS_PER_DAY = 1000 * 60 * 60 * 24;

/**
 * Whole days between the first and last commit. Returns 0 - the value that
 * fails a minimum-span requirement - when either end is missing or
 * unparseable, rather than a NaN that would quietly satisfy it. Also
 * floors at 0 if the dates arrive out of order, which happens for real:
 * a rewritten or backdated commit can carry an author date later than the
 * repo's newest one.
 */
export function historySpanDays(
  firstCommitDate: string | null | undefined,
  lastCommitDate: string | null | undefined
): number {
  const first = parseCommitDate(firstCommitDate);
  const last = parseCommitDate(lastCommitDate);
  if (!first || !last) return 0;
  return Math.max(0, Math.round((last.getTime() - first.getTime()) / MS_PER_DAY));
}
