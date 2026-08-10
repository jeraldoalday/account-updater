import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { apiKeyAuth } from "../src/middleware/apiKeyAuth";

function appWith(expectedKey: string | undefined) {
  const app = express();
  app.use(apiKeyAuth(expectedKey));
  app.get("/protected", (_req, res) => res.status(200).json({ ok: true }));
  return app;
}

describe("apiKeyAuth", () => {
  it("allows requests through when no key is configured", async () => {
    const res = await request(appWith(undefined)).get("/protected");
    expect(res.status).toBe(200);
  });

  it("rejects a missing header when a key is configured", async () => {
    const res = await request(appWith("secret")).get("/protected");
    expect(res.status).toBe(401);
  });

  it("rejects a wrong key", async () => {
    const res = await request(appWith("secret")).get("/protected").set("x-api-key", "nope");
    expect(res.status).toBe(401);
  });

  it("allows the correct key through", async () => {
    const res = await request(appWith("secret")).get("/protected").set("x-api-key", "secret");
    expect(res.status).toBe(200);
  });
});
