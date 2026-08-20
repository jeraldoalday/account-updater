import { setTimeout as delay } from "node:timers/promises";
import { createApp } from "./app";
import { config } from "./config";
import { closeCache } from "./cache/createCache";
import { closeHistoryStore, createHistoryStore } from "./history/createHistoryStore";
import { startRetentionSweeper } from "./history/retention";
import { auditConfig } from "./health/configAudit";
import { gracefulShutdown } from "./lifecycle/gracefulShutdown";

function log(event: Record<string, unknown>): void {
  console.log(JSON.stringify({ level: "info", ...event, time: new Date().toISOString() }));
}

// Surfaced at boot, not just from `npm run doctor`: the settings that are
// fine locally and wrong in production (no API key, no GitHub credential,
// an audit trail in a temp directory) are exactly the ones nobody thinks
// to review before the first deploy.
for (const finding of auditConfig(config)) {
  if (finding.severity === "info") continue;
  console.warn(
    JSON.stringify({
      level: finding.severity === "critical" ? "error" : "warn",
      msg: "config_review",
      id: finding.id,
      detail: finding.message,
      remedy: finding.remedy,
      time: new Date().toISOString()
    })
  );
}

const app = createApp();

/**
 * Prunes the audit trail on boot and periodically after. Failing to open
 * the database here must not stop the service from starting: every write
 * to it is best-effort on the request path, and /ready already reports it
 * as unusable.
 */
function startRetention() {
  try {
    return startRetentionSweeper({
      store: createHistoryStore(),
      retentionDays: config.historyRetentionDays,
      intervalMs: config.historyPruneIntervalMs,
      log
    });
  } catch (err) {
    console.error("Could not start audit-trail retention:", (err as Error).message);
    return { sweep: () => 0, stop: () => {} };
  }
}

const retention = startRetention();

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
      { name: "retention", close: retention.stop },
      { name: "cache", close: closeCache },
      { name: "history", close: closeHistoryStore }
    ],
    wait: (ms) => delay(ms),
    log,
    exit: (code) => process.exit(code)
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
