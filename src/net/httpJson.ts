import { truncate } from "../utils/truncate";

/** How much of an error response body is kept for the error message. */
const MAX_ERROR_BODY_LENGTH = 300;

/** Default ceiling on a single request, including reading the body. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export interface JsonResponse<T> {
  status: number;
  /** Header names lowercased, so callers never have to guess the casing. */
  headers: Record<string, string>;
  data: T;
}

/**
 * A non-2xx response, shaped so the existing error handling recognizes it:
 * `status` and `response.headers` are what `isRateLimitError` and the retry
 * policies read, and they were written against Octokit's errors.
 *
 * Matching that shape here is deliberate. The alternative - a second error
 * type with the same fields under different names - would mean every
 * consumer of an upstream failure (retry classification, the rate-limit
 * surface on 503s, the route's error mapping) needing to know which forge
 * it came from.
 */
export class HttpError extends Error {
  readonly response: { headers: Record<string, string>; body: string };

  constructor(
    readonly status: number,
    readonly url: string,
    headers: Record<string, string>,
    body: string
  ) {
    super(`${status} from ${url}${body ? `: ${truncate(body, MAX_ERROR_BODY_LENGTH)}` : ""}`);
    this.name = "HttpError";
    this.response = { headers, body };
  }
}

/** Thrown when a request exceeded its timeout rather than failing outright. */
export class RequestTimeoutError extends Error {
  constructor(
    readonly url: string,
    readonly timeoutMs: number
  ) {
    super(`Request to ${url} timed out after ${timeoutMs}ms`);
    this.name = "RequestTimeoutError";
  }
}

export interface GetJsonOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
}

function headersToObject(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key.toLowerCase()] = value;
  });
  return result;
}

/**
 * A GET returning parsed JSON plus the response headers.
 *
 * The headers are not incidental: every REST forge reports pagination
 * totals and rate-limit state there, and both matter here - the commit
 * count comes from a pagination header rather than from counting rows, and
 * a caller hitting a quota deserves to be told when it resets.
 *
 * Octokit gives GitHub all of this. GitLab has no comparable client worth
 * the dependency for two endpoints, so this is the whole transport: fetch,
 * a timeout, and errors in the shape the rest of the service already
 * understands.
 */
export async function getJson<T>(
  url: string,
  options: GetJsonOptions = {}
): Promise<JsonResponse<T>> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  // Without this a hung upstream holds the request - and, because an
  // eligibility check fans out to several calls at once, holds a slot in
  // every concurrency budget between here and the caller - until the OS
  // gives up, which can be minutes.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json", ...options.headers },
      signal: controller.signal
    });
  } catch (err) {
    if (controller.signal.aborted) throw new RequestTimeoutError(url, timeoutMs);
    throw err;
  } finally {
    clearTimeout(timer);
  }

  const headers = headersToObject(response.headers);

  if (!response.ok) {
    // Read the body before throwing: an API's error message ("project not
    // found", "insufficient scope") is the one piece of information that
    // makes a failed check actionable, and it is gone once the response is
    // discarded.
    const body = await response.text().catch(() => "");
    throw new HttpError(response.status, url, headers, body);
  }

  return { status: response.status, headers, data: (await response.json()) as T };
}

/**
 * A header that should hold a count, as a number, or null when it is
 * missing or not one. Pagination headers are the source of the commit
 * count, and a NaN there would flow straight into a threshold comparison
 * that silently passes.
 */
export function numericHeader(headers: Record<string, string>, name: string): number | null {
  const raw = headers[name.toLowerCase()];
  if (raw === undefined || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}
