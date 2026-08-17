import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestId } from "../src/middleware/requestId";
import { errorHandler } from "../src/middleware/errorHandler";

function appThatThrows(err: unknown) {
  const app = express();
  app.use(requestId);
  app.get("/boom", (_req, _res) => {
    throw err;
  });
  app.use(errorHandler);
  return app;
}

describe("errorHandler", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it("returns a generic 500 with a request ID for an unexpected error", async () => {
    const res = await request(appThatThrows(new Error("internal secret detail"))).get("/boom");

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Internal server error.");
    expect(res.body.requestId).toBeTruthy();
    expect(res.headers["x-request-id"]).toBe(res.body.requestId);
  });

  it("does not leak the underlying error message to the client", async () => {
    const res = await request(appThatThrows(new Error("internal secret detail"))).get("/boom");

    expect(JSON.stringify(res.body)).not.toMatch(/internal secret detail/);
  });

  it("still logs the underlying error server-side for debugging", async () => {
    await request(appThatThrows(new Error("internal secret detail"))).get("/boom");

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(consoleErrorSpy.mock.calls[0][0] as string);
    expect(logged.level).toBe("error");
    expect(logged.message).toBe("internal secret detail");
    expect(logged.requestId).toBeTruthy();
  });

  it("handles a thrown non-Error value without crashing", async () => {
    const res = await request(appThatThrows("just a string")).get("/boom");

    expect(res.status).toBe(500);
    const logged = JSON.parse(consoleErrorSpy.mock.calls[0][0] as string);
    expect(logged.message).toBe("just a string");
  });

  it("returns 400 with a client-safe message for malformed JSON bodies", async () => {
    const app = express();
    app.use(requestId);
    app.use(express.json());
    app.post("/echo", (req, res) => res.status(200).json(req.body));
    app.use(errorHandler);

    const res = await request(app)
      .post("/echo")
      .set("Content-Type", "application/json")
      .send("{not json");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Request body must be valid JSON.");
    expect(res.body.requestId).toBeTruthy();
    // Malformed-JSON errors are a client mistake, not a server fault - never
    // logged as a server-side error.
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });
});
