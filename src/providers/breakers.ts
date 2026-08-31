import { config } from "../config";
import { CircuitBreaker, type CircuitSnapshot } from "../net/circuitBreaker";
import { isUpstreamUnavailable as bitbucketUnavailable } from "../bitbucket/withRetry";
import { isUpstreamUnavailable as githubUnavailable } from "../github/withRetry";
import { isUpstreamUnavailable as gitlabUnavailable } from "../gitlab/withRetry";
import { PROVIDER_IDS, providerDisplayName, type ProviderId } from "./hosts";

/**
 * Which failures count as "this forge is down", per forge.
 *
 * Kept next to each forge's retry policy rather than guessed centrally,
 * for the reason the retry policies were split up in the first place:
 * every forge has its own opinion about what a status code means, and a
 * shared guess gets one of them wrong. Bitbucket answers a revoked token
 * with 401 where GitLab says 403, and GitHub says 403 for both rate
 * limiting and plain permission failures - reading any of those as an
 * outage would report a configuration mistake as one.
 */
const TRIP_POLICIES: Record<ProviderId, (err: unknown) => boolean> = {
  github: githubUnavailable,
  gitlab: gitlabUnavailable,
  bitbucket: bitbucketUnavailable
};

/**
 * One breaker per forge, built once for the process.
 *
 * Per-forge rather than one shared breaker, because "GitHub is down" says
 * nothing whatsoever about GitLab. A shared one would let any single forge
 * having a bad afternoon refuse checks for repos on the other two, turning
 * one outage into three - the opposite of what this is for.
 *
 * Named with the forge's display name so the refusal a caller reads says
 * "GitHub", not "github".
 */
const BREAKERS: Record<ProviderId, CircuitBreaker> = Object.fromEntries(
  PROVIDER_IDS.map((id) => [
    id,
    new CircuitBreaker(providerDisplayName(id), {
      failureThreshold: config.circuitBreakerFailureThreshold,
      openMs: config.circuitBreakerOpenMs,
      shouldTrip: TRIP_POLICIES[id]
    })
  ])
) as Record<ProviderId, CircuitBreaker>;

export function breakerFor(id: ProviderId): CircuitBreaker {
  return BREAKERS[id];
}

/**
 * Every forge's breaker state, for /metrics and the readiness probe.
 *
 * All of them, including the ones that are closed: "GitHub is fine" is
 * the answer to a question an operator is actually asking during an
 * incident, and a map that only lists the broken ones can't be told apart
 * from a map that isn't being populated.
 */
export function breakerSnapshots(): Record<ProviderId, CircuitSnapshot> {
  return Object.fromEntries(PROVIDER_IDS.map((id) => [id, BREAKERS[id].snapshot()])) as Record<
    ProviderId,
    CircuitSnapshot
  >;
}

/** Closes every breaker. For tests, and for an operator-triggered reset. */
export function resetBreakers(): void {
  for (const id of PROVIDER_IDS) BREAKERS[id].reset();
}
