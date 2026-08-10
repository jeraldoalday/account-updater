import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { requestId } from "../src/middleware/requestId";

function app() {
  const app = express();
  app.use(requestId);
  app.get("/ping", (req, res) => res.status(200).json({ id: req.id }));
  return app;
}

describe("requestId", () => {
  it("generates an id and echoes it on the response header", async () => {
    const res = await request(app()).get("/ping");
    expect(res.headers["x-request-id"]).toBeTruthy();
    expect(res.body.id).toBe(res.headers["x-request-id"]);
  });

  it("reuses an incoming x-request-id instead of generating a new one", async () => {
    const res = await request(app()).get("/ping").set("x-request-id", "caller-supplied-id");
    expect(res.headers["x-request-id"]).toBe("caller-supplied-id");
    expect(res.body.id).toBe("caller-supplied-id");
  });

  it("generates distinct ids for separate requests", async () => {
    const a = app();
    const first = await request(a).get("/ping");
    const second = await request(a).get("/ping");
    expect(first.body.id).not.toBe(second.body.id);
  });
});
