import { Router } from "express";
import { PROVIDER_IDS, providerHost } from "../providers/hosts";
import { isProviderSupported, providerCapabilities } from "../providers/registry";
import type { ProviderId } from "../providers/hosts";

export interface ProviderDescription {
  id: ProviderId;
  displayName: string;
  /** Host a repo on this forge is cloned from. */
  host: string;
  /** Whether a reference to this forge is actually evaluated. */
  supported: boolean;
  /** Whether a project can live under nested groups ("group/subgroup/name"). */
  nestedNamespaces: boolean;
  /**
   * Which signals the forge's API can contribute. Absent for a forge that
   * is recognized but not implemented, where the answer is "none" rather
   * than a set of capabilities nothing has exercised.
   */
  signals?: { pushEvents: boolean };
  /** A reference in the shape this forge expects, for a caller to copy. */
  example: string;
}

/**
 * What each forge is called, whether it can be evaluated, and what a
 * reference to it looks like.
 *
 * Assembled from the host table and the registry rather than written out,
 * so it cannot drift from what the service will actually accept - which is
 * the only reason to prefer this over the prose in the OpenAPI
 * description.
 */
export function describeProviders(): ProviderDescription[] {
  return PROVIDER_IDS.map((id) => {
    const spec = providerHost(id);
    const capabilities = providerCapabilities(id);
    return {
      id,
      displayName: spec.displayName,
      host: spec.host,
      supported: isProviderSupported(id),
      nestedNamespaces: spec.supportsNestedNamespaces,
      ...(capabilities ? { signals: { pushEvents: capabilities.pushEvents } } : {}),
      example: `https://${spec.host}/acme/widgets`
    };
  });
}

export const providersRouter = Router();

// Unauthenticated and outside the /eligibility rate limit, alongside
// /health and /openapi.json: this is a client asking what it is allowed to
// send *before* it sends anything, and answering that is cheaper than
// having it guess and be refused. It reports nothing an operator would
// mind publishing - which forge is which, and what this build can evaluate
// - and deliberately not whether a credential is configured for any of
// them. That belongs to `npm run doctor`, which is run by someone who
// already has the environment.
providersRouter.get("/", (_req, res) => {
  res.status(200).json({ providers: describeProviders() });
});
