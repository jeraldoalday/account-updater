import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gracefulShutdown, type ClosableServer } from "../src/lifecycle/gracefulShutdown";
import { isDraining, resetDrainState } from "../src/lifecycle/drainState";

/**
 * A stand-in for http.Server that records the order operations happened
 * in, since ordering - drain before close, close before releasing
 * dependencies - is the behaviour under test, not any single call.
 */
function fakeServer(options: { closeError?: Error; neverCloses?: boolean } = {}) {
  const calls: string[] = [];
  let finishClose: (() => void) | undefined;

  const server: ClosableServer = {
    close(callback) {
      calls.push("close");
      if (options.neverCloses) {
        finishClose = () => callback();
        return;
      }
      callback(options.closeError);
    },
    closeIdleConnections() {
      calls.push("closeIdleConnections");
    },
    closeAllConnections() {
      calls.push("closeAllConnections");
    }
  };

  return { server, calls, finishClose: () => finishClose?.() };
}

/** Resolves the shortest pending wait first, the way real timers would. */
function fakeClock() {
  const pending: { ms: number; resolve: () => void }[] = [];
  return {
    wait: (ms: number) =>
      new Promise<void>((resolve) => {
        pending.push({ ms, resolve });
      }),
    /** Fires every wait registered for `ms` or less. */
    advance: async (ms: number) => {
      for (const timer of [...pending]) {
        if (timer.ms <= ms) {
          pending.splice(pending.indexOf(timer), 1);
          timer.resolve();
        }
      }
      await Promise.resolve();
      await Promise.resolve();
    },
    pending
  };
}

describe("gracefulShutdown", () => {
  const exit = vi.fn();
  const log = vi.fn();

  beforeEach(() => {
    exit.mockReset();
    log.mockReset();
    resetDrainState();
  });

  afterEach(() => {
    resetDrainState();
  });

  it("flips readiness to draining before it closes the listener", async () => {
    const { server, calls } = fakeServer();
    const clock = fakeClock();

    const done = gracefulShutdown("SIGTERM", {
      server,
      drainMs: 5_000,
      graceMs: 20_000,
      closers: [],
      wait: clock.wait,
      log,
      exit
    });

    // The whole point of the drain window: still serving, already
    // reporting itself as not-ready.
    expect(isDraining()).toBe(true);
    expect(calls).toEqual([]);

    await clock.advance(5_000);
    await done;

    expect(calls).toContain("close");
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("drops idle keep-alive connections so they can't hold the close open", async () => {
    const { server, calls } = fakeServer();
    const clock = fakeClock();

    const done = gracefulShutdown("SIGTERM", {
      server,
      drainMs: 100,
      graceMs: 5_000,
      closers: [],
      wait: clock.wait,
      log,
      exit
    });
    await clock.advance(100);
    await done;

    expect(calls).toEqual(["close", "closeIdleConnections"]);
  });

  it("releases dependencies after the listener is closed, not before", async () => {
    const order: string[] = [];
    const { server } = fakeServer();
    const clock = fakeClock();
    server.close = (callback) => {
      order.push("close");
      callback();
    };

    const done = gracefulShutdown("SIGTERM", {
      server,
      drainMs: 10,
      graceMs: 5_000,
      closers: [
        { name: "cache", close: () => void order.push("cache") },
        { name: "history", close: () => void order.push("history") }
      ],
      wait: clock.wait,
      log,
      exit
    });
    await clock.advance(10);
    await done;

    expect(order).toEqual(["close", "cache", "history"]);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("keeps closing the rest when one dependency refuses to close", async () => {
    const closed: string[] = [];
    const { server } = fakeServer();
    const clock = fakeClock();

    const done = gracefulShutdown("SIGTERM", {
      server,
      drainMs: 10,
      graceMs: 5_000,
      closers: [
        {
          name: "cache",
          close: () => Promise.reject(new Error("redis connection already gone"))
        },
        { name: "history", close: () => void closed.push("history") }
      ],
      wait: clock.wait,
      log,
      exit
    });
    await clock.advance(10);
    await done;

    expect(closed).toEqual(["history"]);
    expect(exit).toHaveBeenCalledWith(0);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "shutdown_closer_error", closer: "cache" })
    );
  });

  it("gives up at the deadline when in-flight requests never finish", async () => {
    const { server, calls } = fakeServer({ neverCloses: true });
    const clock = fakeClock();

    const done = gracefulShutdown("SIGTERM", {
      server,
      drainMs: 10,
      graceMs: 1_000,
      closers: [{ name: "cache", close: vi.fn() }],
      wait: clock.wait,
      log,
      exit
    });

    await clock.advance(10);
    expect(exit).not.toHaveBeenCalled();

    await clock.advance(1_000);
    await done;

    // Cutting the remaining sockets is the only way out; exiting 1 says
    // the shutdown didn't complete cleanly.
    expect(calls).toContain("closeAllConnections");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("exits non-zero when the listener itself fails to close", async () => {
    const { server } = fakeServer({ closeError: new Error("not running") });
    const clock = fakeClock();

    const done = gracefulShutdown("SIGTERM", {
      server,
      drainMs: 10,
      graceMs: 5_000,
      closers: [],
      wait: clock.wait,
      log,
      exit
    });
    await clock.advance(10);
    await done;

    expect(exit).toHaveBeenCalledWith(1);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "shutdown_listener_error", error: "not running" })
    );
  });

  it("survives a server too old to expose the connection-closing helpers", async () => {
    // closeIdleConnections/closeAllConnections arrived in Node 18.2; the
    // optional calls must not be the thing that breaks shutdown.
    const clock = fakeClock();
    const server: ClosableServer = { close: (callback) => callback() };

    const done = gracefulShutdown("SIGTERM", {
      server,
      drainMs: 10,
      graceMs: 5_000,
      closers: [],
      wait: clock.wait,
      log,
      exit
    });
    await clock.advance(10);
    await done;

    expect(exit).toHaveBeenCalledWith(0);
  });
});

describe("drain state", () => {
  beforeEach(() => resetDrainState());
  afterEach(() => resetDrainState());

  it("starts not draining", () => {
    expect(isDraining()).toBe(false);
  });
});
