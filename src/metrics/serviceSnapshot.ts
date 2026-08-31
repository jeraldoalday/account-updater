import { metrics, type MetricsSnapshot } from "./metrics";
import { breakerSnapshots } from "../providers/breakers";
import type { CircuitSnapshot } from "../net/circuitBreaker";
import type { ProviderId } from "../providers/hosts";

export interface ServiceSnapshot extends MetricsSnapshot {
  /**
   * Each forge's circuit breaker, including the closed ones.
   *
   * A gauge, not a counter, which is why it is composed here rather than
   * kept in the Metrics class: everything in there is a number this
   * process has been adding up since it started, and `reset()` means
   * something for those. Breaker state is a fact about the world right
   * now, read from the breakers themselves at the moment of the scrape,
   * and resetting the counters must not pretend a forge came back.
   */
  providerCircuits: Record<ProviderId, CircuitSnapshot>;
}

/**
 * Everything GET /metrics reports: the counters this process has
 * accumulated, plus the current state of each forge's breaker.
 *
 * The breaker state is the part an operator needs during an incident and
 * the part nothing else surfaces. A forge being refused shows up in the
 * counters only as an absence - checks that didn't happen - which is
 * indistinguishable from quiet traffic.
 */
export function serviceSnapshot(): ServiceSnapshot {
  return { ...metrics.snapshot(), providerCircuits: breakerSnapshots() };
}
