/**
 * Caps caller-controlled text before it is echoed into a response body or
 * a log line.
 *
 * A request path is chosen entirely by whoever sent it, and both places it
 * gets repeated - the JSON 404 body and the access log - are unbounded by
 * default. That makes a few kilobytes of URL into a few kilobytes of log
 * per request, which is a cheap way to fill a log budget. Truncation keeps
 * enough to recognize the path and marks that it was cut, so nobody reads
 * the shortened value as the whole story.
 */
export function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

/** Shared cap for request paths: long enough to spot a typo'd route. */
export const MAX_ECHOED_PATH_LENGTH = 200;
