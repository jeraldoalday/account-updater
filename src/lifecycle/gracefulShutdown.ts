import { beginDraining } from "./drainState";

/** The parts of `http.Server` shutdown needs, so a test can supply a fake. */
export interface ClosableServer {
  close(callback: (err?: Error) => void): void;
  /**
   * Node 18.2+. Keep-alive connections that are idle between requests
   * still count as open, and `close()` waits for every open connection —
   * so without this a browser or proxy holding a warm socket keeps the
   * process alive until the hard deadline fires, turning every deploy
   * into a full grace-period stall.
   */
  closeIdleConnections?(): void;
  /** Node 18.2+. Last resort at the deadline: cut the sockets still active. */
  closeAllConnections?(): void;
}

export interface Closer {
  name: string;
  close: () => void | Promise<void>;
}

export interface ShutdownOptions {
  server: ClosableServer;
  /**
   * How long to keep serving after the drain flag flips, before closing
   * the listener. This is the window in which the load balancer's
   * readiness probe sees 503 and takes the instance out of rotation; it
   * should be at least one probe interval, or draining buys nothing.
   */
  drainMs: number;
  /** Hard deadline for the whole shutdown, after which the process is killed. */
  graceMs: number;
  /** Connections to release once the listener is closed (cache, database). */
  closers: Closer[];
  wait: (ms: number) => Promise<void>;
  log: (event: Record<string, unknown>) => void;
  exit: (code: number) => void;
}

function closeServer(server: ClosableServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
    // Only idle sockets: anything mid-request is left alone to finish,
    // which is the whole point of a graceful shutdown.
    server.closeIdleConnections?.();
  });
}

/**
 * Shuts the service down in the order a load balancer can follow:
 *
 *   1. flip readiness to draining, so `/ready` starts answering 503;
 *   2. keep serving for `drainMs`, long enough for that to be observed;
 *   3. close the listener, letting in-flight requests (a slow clone can
 *      take a while) finish while idle keep-alive sockets are dropped;
 *   4. release the cache and audit-trail connections;
 *   5. exit.
 *
 * A hard deadline covers the case where step 3 never finishes — the
 * alternative is a process that hangs forever and gets SIGKILLed with its
 * SQLite connection still open.
 *
 * Extracted from `index.ts` and given injectable timers/exit because the
 * ordering above is the entire point of the code, and ordering is exactly
 * what an untested `process.on("SIGTERM", ...)` block silently loses.
 */
export async function gracefulShutdown(signal: string, options: ShutdownOptions): Promise<void> {
  const { server, drainMs, graceMs, closers, wait, log, exit } = options;

  log({ msg: "shutdown_started", signal, drainMs, graceMs });
  beginDraining();

  let deadlineReached = false;
  const deadline = wait(graceMs).then(() => {
    deadlineReached = true;
  });

  await Promise.race([wait(drainMs), deadline]);
  if (deadlineReached) return forceExit(server, log, exit);

  log({ msg: "shutdown_closing_listener", signal });
  try {
    await Promise.race([closeServer(server), deadline]);
  } catch (err) {
    log({ msg: "shutdown_listener_error", error: (err as Error).message });
    return forceExit(server, log, exit);
  }
  if (deadlineReached) return forceExit(server, log, exit);

  for (const closer of closers) {
    try {
      await closer.close();
    } catch (err) {
      // A dependency that won't close cleanly is worth a log line, but not
      // worth failing the shutdown over: the process is going away anyway.
      log({ msg: "shutdown_closer_error", closer: closer.name, error: (err as Error).message });
    }
  }

  log({ msg: "shutdown_complete", signal });
  exit(0);
}

function forceExit(
  server: ClosableServer,
  log: ShutdownOptions["log"],
  exit: ShutdownOptions["exit"]
): void {
  log({ msg: "shutdown_deadline_exceeded" });
  server.closeAllConnections?.();
  exit(1);
}
