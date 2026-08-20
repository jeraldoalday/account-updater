/**
 * Whether this process has started shutting down.
 *
 * A rolling deploy removes an instance from its load balancer because a
 * probe says so, not because the process received a signal — the two
 * happen in that order only if the process tells the probe. Without this
 * flag, SIGTERM goes straight to `server.close()`, which stops accepting
 * connections immediately while the load balancer is still routing to
 * this instance for another probe interval, and every request it sends in
 * that gap is a connection error the caller sees.
 *
 * So the flag is flipped first and only later acted on: `GET /ready`
 * starts answering 503 ("stop sending traffic") while the process keeps
 * serving whatever is already in flight, and `GET /health` keeps
 * answering 200 so the platform doesn't count a draining instance as a
 * crashed one and restart it mid-shutdown.
 */
let draining = false;

export function beginDraining(): void {
  draining = true;
}

export function isDraining(): boolean {
  return draining;
}

/** Test-only: module state outlives a single test otherwise. */
export function resetDrainState(): void {
  draining = false;
}
