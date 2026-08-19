import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const ENV_KEYS = ["HISTORY_DB_PATH"] as const;
const originalEnv = { ...process.env };

let tmpDir: string;

async function loadCreateHistoryStoreWith(dbFileName: string) {
  vi.resetModules();
  for (const key of ENV_KEYS) delete process.env[key];
  tmpDir = mkdtempSync(join(tmpdir(), "account-updater-history-"));
  process.env.HISTORY_DB_PATH = join(tmpDir, dbFileName);
  return import("../src/history/createHistoryStore");
}

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, originalEnv);
  vi.resetModules();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe("createHistoryStore", () => {
  it("returns a working SQLite-backed store, creating the parent directory as needed", async () => {
    const { createHistoryStore } = await loadCreateHistoryStoreWith("nested/history.db");
    const store = createHistoryStore();

    store.record({
      eligible: true,
      repo: { provider: "github", owner: "o", repo: "r" },
      checks: {} as never,
      reasons: []
    });

    expect(store.listForRepo({ provider: "github", owner: "o", repo: "r" })).toHaveLength(1);
  });

  it("reuses the same underlying connection across multiple createHistoryStore() calls", async () => {
    const { createHistoryStore } = await loadCreateHistoryStoreWith("history.db");

    createHistoryStore().record({
      eligible: false,
      repo: { provider: "github", owner: "o", repo: "r" },
      checks: {} as never,
      reasons: ["nope"]
    });

    expect(
      createHistoryStore().listForRepo({ provider: "github", owner: "o", repo: "r" })
    ).toHaveLength(1);
  });

  describe("closeHistoryStore", () => {
    it("does nothing when no connection was ever opened", async () => {
      const { closeHistoryStore } = await loadCreateHistoryStoreWith("history.db");
      expect(() => closeHistoryStore()).not.toThrow();
    });

    it("closes the connection so a later createHistoryStore() call reopens it", async () => {
      const { createHistoryStore, closeHistoryStore } =
        await loadCreateHistoryStoreWith("history.db");

      createHistoryStore().record({
        eligible: true,
        repo: { provider: "github", owner: "o", repo: "r" },
        checks: {} as never,
        reasons: []
      });
      closeHistoryStore();

      // A fresh store reopens the (still on-disk) file rather than throwing
      // on a closed connection.
      const store = createHistoryStore();
      expect(store.listForRepo({ provider: "github", owner: "o", repo: "r" })).toHaveLength(1);
    });
  });
});
