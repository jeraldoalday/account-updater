import { createCache } from "../cache/createCache";
import { createHistoryStore } from "../history/createHistoryStore";
import { isDraining } from "../lifecycle/drainState";

export interface DependencyStatus {
  ok: boolean;
  error?: string;
}

export interface ReadinessReport {
  ready: boolean;
  /**
   * True once the process has begun shutting down. Reported separately
   * from `ready` so an operator can tell "this instance is on its way out"
   * apart from "this instance's Redis is broken" - both are 503, but only
   * one of them is a problem.
   */
  draining: boolean;
  checks: {
    cache: DependencyStatus;
    history: DependencyStatus;
  };
}

/**
 * GET /health answers "is this process alive", which a container platform
 * uses to decide whether to restart it. That is a different question from
 * "should traffic be sent here", and the service has two dependencies that
 * can be down while the process is perfectly alive: the (optionally
 * shared) cache backend and the SQLite audit trail.
 *
 * Both failures are deliberately non-fatal on the request path - a cache
 * error degrades to a miss, an audit-trail write failure is swallowed so
 * it can't fail a caller's check - which is exactly why they need an
 * explicit probe. Without one, a deployment pointing at an unreachable
 * Redis looks entirely healthy while every request pays full clone and
 * GitHub API cost.
 */
async function checkCache(): Promise<DependencyStatus> {
  try {
    await createCache().ping();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

function checkHistory(): DependencyStatus {
  try {
    createHistoryStore().ping();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function checkReadiness(): Promise<ReadinessReport> {
  const cache = await checkCache();
  const history = checkHistory();
  const draining = isDraining();
  return { ready: !draining && cache.ok && history.ok, draining, checks: { cache, history } };
}
