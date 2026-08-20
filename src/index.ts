import { setTimeout as delay } from "node:timers/promises";
import { createApp } from "./app";
import { config } from "./config";
import { closeCache } from "./cache/createCache";
import { closeHistoryStore } from "./history/createHistoryStore";
import { gracefulShutdown } from "./lifecycle/gracefulShutdown";

const app = createApp();

const server = app.listen(config.port, () => {
  console.log(`account-updater listening on port ${config.port}`);
});

let shuttingDown = false;

function shutdown(signal: string): void {
  // A second SIGTERM (or an impatient Ctrl-C) means "stop waiting", not
  // "start a second shutdown racing the first".
  if (shuttingDown) {
    console.log(`${signal} received again, exiting immediately`);
    process.exit(1);
  }
  shuttingDown = true;

  void gracefulShutdown(signal, {
    server,
    drainMs: config.shutdownDrainMs,
    graceMs: config.shutdownGraceMs,
    closers: [
      { name: "cache", close: closeCache },
      { name: "history", close: closeHistoryStore }
    ],
    wait: (ms) => delay(ms),
    log: (event) =>
      console.log(JSON.stringify({ level: "info", ...event, time: new Date().toISOString() })),
    exit: (code) => process.exit(code)
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
