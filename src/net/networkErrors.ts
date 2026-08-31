/**
 * Errno values Node reports when a request never reached a server, or
 * reached one that then vanished. Each of them means "no HTTP answer came
 * back", which is a different thing from an answer this service didn't
 * like.
 */
const NETWORK_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_TIMEOUT"
]);

/** How many `cause` links to follow. */
const MAX_CAUSE_DEPTH = 5;

/**
 * Whether an error is the network failing to deliver the request, rather
 * than an upstream answering unhappily.
 *
 * The distinction matters wherever a decision is being made about the
 * *upstream's* health: a refused connection or a DNS failure says the
 * forge is unreachable, while a 404 says it is up and answering. Getting
 * this wrong in the permissive direction is the expensive one - treating
 * any error without an HTTP status as "the forge is down" would let a
 * plain programming mistake in this service, which also has no status,
 * look exactly like an outage.
 *
 * `fetch` reports these as a bare `TypeError: fetch failed` with the real
 * errno hidden in `cause`, so the chain is walked rather than only the top
 * error inspected. Bounded, because a cause chain can be circular.
 */
export function isNetworkError(err: unknown): boolean {
  let current: unknown = err;

  for (
    let depth = 0;
    depth < MAX_CAUSE_DEPTH && current !== null && current !== undefined;
    depth++
  ) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && NETWORK_ERROR_CODES.has(code)) return true;

    const next = (current as { cause?: unknown }).cause;
    if (next === current) return false;
    current = next;
  }

  return false;
}
