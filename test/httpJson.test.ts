import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getJson,
  numericHeader,
  HttpError,
  RequestTimeoutError,
  DEFAULT_REQUEST_TIMEOUT_MS
} from "../src/net/httpJson";

function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {}
) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers }
  });
}

function mockFetch(impl: (url: string, init: RequestInit) => Promise<Response>) {
  const spy = vi.fn(impl);
  vi.stubGlobal("fetch", spy);
  return spy;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("getJson", () => {
  it("returns the parsed body and the response headers", async () => {
    mockFetch(async () => jsonResponse([{ id: 1 }], { headers: { "X-Total": "42" } }));

    const response = await getJson<{ id: number }[]>("https://example.test/things");

    expect(response.status).toBe(200);
    expect(response.data).toEqual([{ id: 1 }]);
    // Lowercased on the way out, so callers don't have to guess which
    // casing a given forge chose.
    expect(response.headers["x-total"]).toBe("42");
  });

  it("sends the caller's headers alongside a JSON accept header", async () => {
    const fetchSpy = mockFetch(async () => jsonResponse({}));

    await getJson("https://example.test/things", { headers: { "private-token": "secret" } });

    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    expect(init.headers).toMatchObject({
      accept: "application/json",
      "private-token": "secret"
    });
  });

  it("throws an HttpError carrying the status, headers, and body of a failure", async () => {
    mockFetch(
      async () =>
        new Response('{"message":"404 Project Not Found"}', {
          status: 404,
          headers: { "x-request-id": "abc" }
        })
    );

    const error = await getJson("https://example.test/projects/nope").catch((e) => e);

    expect(error).toBeInstanceOf(HttpError);
    expect(error.status).toBe(404);
    // The upstream's own message is what makes the failure actionable, so
    // it must survive into the error rather than being discarded with the
    // response.
    expect(error.message).toContain("404 Project Not Found");
    expect(error.response.headers["x-request-id"]).toBe("abc");
  });

  it("shapes the error like an Octokit one, so shared rate-limit handling still reads it", async () => {
    mockFetch(
      async () =>
        new Response("too many requests", {
          status: 429,
          headers: { "retry-after": "12" }
        })
    );

    const error = (await getJson("https://example.test/x").catch((e) => e)) as HttpError;

    expect(error.status).toBe(429);
    expect(error.response.headers["retry-after"]).toBe("12");
  });

  it("truncates a huge error body instead of putting all of it in the message", async () => {
    mockFetch(async () => new Response("x".repeat(5_000), { status: 500 }));

    const error = (await getJson("https://example.test/x").catch((e) => e)) as HttpError;

    expect(error.message.length).toBeLessThan(500);
    expect(error.message).toContain("...");
  });

  it("aborts a request that outlives its timeout", async () => {
    vi.useFakeTimers();
    mockFetch(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          (init.signal as AbortSignal).addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
          );
        })
    );

    const pending = getJson("https://example.test/slow", { timeoutMs: 50 }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(50);

    const error = await pending;
    expect(error).toBeInstanceOf(RequestTimeoutError);
    expect(error.message).toContain("50ms");
  });

  it("lets a genuine network failure through as itself", async () => {
    mockFetch(async () => {
      throw new Error("getaddrinfo ENOTFOUND example.test");
    });

    await expect(getJson("https://example.test/x")).rejects.toThrow(/ENOTFOUND/);
  });

  it("has a default timeout, so a call with no options can still not hang forever", () => {
    expect(DEFAULT_REQUEST_TIMEOUT_MS).toBeGreaterThan(0);
  });
});

describe("numericHeader", () => {
  it("reads a count regardless of the casing the caller asks for", () => {
    expect(numericHeader({ "x-total": "137" }, "X-Total")).toBe(137);
  });

  it("returns null for a missing, blank, or non-numeric header", () => {
    // A NaN here would reach a threshold comparison, where every
    // comparison against it is false - so a repo with an unreadable commit
    // count would quietly pass the minimum-commits check.
    expect(numericHeader({}, "x-total")).toBeNull();
    expect(numericHeader({ "x-total": "  " }, "x-total")).toBeNull();
    expect(numericHeader({ "x-total": "many" }, "x-total")).toBeNull();
  });
});
