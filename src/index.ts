import { createApp } from "./app";
import { config } from "./config";
import { closeCache } from "./cache/createCache";

const app = createApp();

const server = app.listen(config.port, () => {
  console.log(`account-updater listening on port ${config.port}`);
});

function shutdown(signal: string): void {
  console.log(`${signal} received, shutting down...`);
  server.close((err) => {
    if (err) {
      console.error("Error while closing the server:", err);
      process.exit(1);
    }
    closeCache()
      .catch((cacheErr) => console.error("Error while closing the cache connection:", cacheErr))
      .finally(() => process.exit(0));
  });
  // Force-exit if in-flight requests (e.g. a slow clone) don't finish in time.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
