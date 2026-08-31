import { beforeEach, describe, expect, it, vi } from "vitest";
import { CircuitBreaker, CircuitOpenError } from "../src/net/circuitBreaker";

/** A clock a test can move, so nothing has to wait out a real cooldown. */
function fakeClock(start = 1_700_000_000_000) {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    }
  };
}

function breaker(overrides: Partial<ConstructorParameters<typeof CircuitBreaker>[1]> = {}) {
  const clock = fakeClock();
  const cb = new CircuitBreaker("TestForge", {
    failureThreshold: 3,
    openMs: 30_000,
    now: clock.now,
    ...overrides
  });
  return { cb, clock };
}

const boom = () => Promise.reject(new Error("upstream timed out"));
const fine = () => Promise.resolve("ok");

/** The refusal a call gets while the circuit is open. */
async function refusalFrom(cb: CircuitBreaker): Promise<CircuitOpenError> {
  try {
    await cb.run(fine);
  } catch (err) {
    return err as CircuitOpenError;
  }
  throw new Error("expected the circuit to refuse the call, but it went through");
}

async function failTimes(cb: CircuitBreaker, times: number, fn = boom): Promise<void> {
  for (let i = 0; i < times; i++) {
    await expect(cb.run(fn)).rejects.toThrow();
  }
}

describe("CircuitBreaker while the upstream is healthy", () => {
  it("passes a call straight through and returns its value", async () => {
    const { cb } = breaker();
    await expect(cb.run(fine)).resolves.toBe("ok");
  });

  it("starts closed", () => {
    const { cb } = breaker();
    expect(cb.state()).toBe("closed");
  });

  it("rethrows a failure rather than swallowing it", async () => {
    const { cb } = breaker();
    await expect(cb.run(boom)).rejects.toThrow("upstream timed out");
  });

  it("stays closed while failures are below the threshold", async () => {
    const { cb } = breaker();
    await failTimes(cb, 2);
    expect(cb.state()).toBe("closed");
  });

  // Consecutive, not cumulative: an upstream that fails occasionally and
  // succeeds in between is serving, and cutting it off would turn a
  // degraded forge into an unavailable one.
  it("forgets earlier failures once a call succeeds", async () => {
    const { cb } = breaker();
    await failTimes(cb, 2);
    await cb.run(fine);
    await failTimes(cb, 2);

    expect(cb.state()).toBe("closed");
  });
});

describe("CircuitBreaker once the upstream stops answering", () => {
  it("opens after the configured run of failures", async () => {
    const { cb } = breaker();
    await failTimes(cb, 3);
    expect(cb.state()).toBe("open");
  });

  it("refuses without calling the upstream at all", async () => {
    const { cb } = breaker();
    await failTimes(cb, 3);

    const call = vi.fn(fine);
    await expect(cb.run(call)).rejects.toThrow(CircuitOpenError);
    expect(call).not.toHaveBeenCalled();
  });

  it("names the upstream and how long to wait, not just 'try later'", async () => {
    const { cb } = breaker();
    await failTimes(cb, 3);

    const err = await refusalFrom(cb);
    expect(err).toBeInstanceOf(CircuitOpenError);
    expect(err.circuit).toBe("TestForge");
    expect(err.retryAfterMs).toBe(30_000);
    expect(err.message).toContain("TestForge");
    expect(err.message).toContain("upstream timed out");
  });

  it("counts down the wait as the cooldown elapses", async () => {
    const { cb, clock } = breaker();
    await failTimes(cb, 3);
    clock.advance(20_000);

    const err = await refusalFrom(cb);
    expect(err.retryAfterMs).toBe(10_000);
  });
});

describe("CircuitBreaker probing for recovery", () => {
  it("lets one call through once the cooldown has elapsed", async () => {
    const { cb, clock } = breaker();
    await failTimes(cb, 3);
    clock.advance(30_000);

    expect(cb.state()).toBe("half-open");
    await expect(cb.run(fine)).resolves.toBe("ok");
  });

  it("closes again when the probe succeeds", async () => {
    const { cb, clock } = breaker();
    await failTimes(cb, 3);
    clock.advance(30_000);
    await cb.run(fine);

    expect(cb.state()).toBe("closed");
    expect(cb.snapshot().consecutiveFailures).toBe(0);
  });

  // A recovering upstream should meet one request, not the whole backlog
  // that piled up while it was down.
  it("keeps refusing everyone else while the probe is in flight", async () => {
    const { cb, clock } = breaker();
    await failTimes(cb, 3);
    clock.advance(30_000);

    let release: (() => void) | undefined;
    const probe = cb.run(
      () =>
        new Promise<string>((resolve) => {
          release = () => resolve("ok");
        })
    );

    await expect(cb.run(fine)).rejects.toThrow(CircuitOpenError);
    release?.();
    await expect(probe).resolves.toBe("ok");
  });

  it("reopens for a fresh cooldown when the probe fails", async () => {
    const { cb, clock } = breaker();
    await failTimes(cb, 3);
    clock.advance(30_000);
    await expect(cb.run(boom)).rejects.toThrow("upstream timed out");

    expect(cb.state()).toBe("open");
    const err = await refusalFrom(cb);
    expect(err.retryAfterMs).toBe(30_000);
  });

  it("lets a probe through again after each cooldown, rather than staying shut", async () => {
    const { cb, clock } = breaker();
    await failTimes(cb, 3);

    for (let round = 0; round < 3; round++) {
      clock.advance(30_000);
      expect(cb.state()).toBe("half-open");
      await expect(cb.run(boom)).rejects.toThrow("upstream timed out");
      expect(cb.state()).toBe("open");
    }
  });
});

describe("CircuitBreaker and errors that don't mean the upstream is down", () => {
  const notFound = () => Promise.reject(new Error("404 no such repo"));
  const isTransient = (err: unknown) => !(err as Error).message.startsWith("404");

  // A repo that doesn't exist is an answer, and an upstream that answers
  // is up. Counting these would let one caller's run of bad refs cut every
  // other caller off from a healthy forge.
  it("does not open on failures the policy doesn't count", async () => {
    const { cb } = breaker({ shouldTrip: isTransient });
    await failTimes(cb, 10, notFound);

    expect(cb.state()).toBe("closed");
  });

  it("still rethrows them untouched", async () => {
    const { cb } = breaker({ shouldTrip: isTransient });
    await expect(cb.run(notFound)).rejects.toThrow("404 no such repo");
  });

  it("treats one as evidence of recovery when it answers a probe", async () => {
    const { cb, clock } = breaker({ shouldTrip: isTransient });
    await failTimes(cb, 3);
    clock.advance(30_000);

    await expect(cb.run(notFound)).rejects.toThrow("404 no such repo");
    expect(cb.state()).toBe("closed");
  });

  it("clears a run of counted failures when an uncounted one answers", async () => {
    const { cb } = breaker({ shouldTrip: isTransient });
    await failTimes(cb, 2);
    await expect(cb.run(notFound)).rejects.toThrow();
    await failTimes(cb, 2);

    expect(cb.state()).toBe("closed");
  });
});

describe("CircuitBreaker snapshot", () => {
  let subject: CircuitBreaker;
  let clock: ReturnType<typeof fakeClock>;

  beforeEach(() => {
    const made = breaker();
    subject = made.cb;
    clock = made.clock;
  });

  it("says nothing about an opening that hasn't happened", () => {
    expect(subject.snapshot()).toEqual({
      name: "TestForge",
      state: "closed",
      consecutiveFailures: 0
    });
  });

  it("reports the failures accumulated so far while still closed", async () => {
    await failTimes(subject, 2);

    expect(subject.snapshot()).toMatchObject({ state: "closed", consecutiveFailures: 2 });
  });

  it("reports when it opened, what for, and how long is left", async () => {
    await failTimes(subject, 3);
    clock.advance(5_000);

    expect(subject.snapshot()).toMatchObject({
      name: "TestForge",
      state: "open",
      consecutiveFailures: 3,
      retryAfterMs: 25_000,
      lastError: "upstream timed out"
    });
    expect(subject.snapshot().openedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("reports half-open once the cooldown has passed", async () => {
    await failTimes(subject, 3);
    clock.advance(30_000);

    expect(subject.snapshot()).toMatchObject({ state: "half-open", retryAfterMs: 0 });
  });

  it("comes back clean after a reset", async () => {
    await failTimes(subject, 3);
    subject.reset();

    expect(subject.snapshot()).toEqual({
      name: "TestForge",
      state: "closed",
      consecutiveFailures: 0
    });
  });

  it("stringifies a non-Error rejection rather than reporting undefined", async () => {
    await expect(subject.run(() => Promise.reject("just a string"))).rejects.toBeTruthy();

    expect(subject.snapshot().lastError).toBe("just a string");
  });
});
