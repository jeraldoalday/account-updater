import type { RepoRef } from "../types";

/**
 * The forges this service knows how to *name*. Only "github" is actually
 * implemented (see `src/providers/registry.ts`); the other two exist so a
 * caller pasting a GitLab or Bitbucket URL gets a precise "not supported
 * yet" answer instead of a confusing parse failure, and so adding a real
 * implementation later is a registry entry rather than a rewrite.
 */
export type ProviderId = "github" | "gitlab" | "bitbucket";

export interface ProviderHostSpec {
  id: ProviderId;
  displayName: string;
  /** Canonical host, used to build clone URLs. */
  host: string;
  /**
   * Hostnames accepted when parsing a repo URL: the canonical host and its
   * subdomains, nothing else. Anchored at both ends so a lookalike host
   * ("github.com.evil.test", "notgithub.com") can't slip through — this is
   * the SSRF guard, so keep it strict.
   */
  hostPattern: RegExp;
  /** SSH shorthand prefix, e.g. "git@github.com:". */
  sshPrefix: string;
}

export const PROVIDER_HOSTS: Record<ProviderId, ProviderHostSpec> = {
  github: {
    id: "github",
    displayName: "GitHub",
    host: "github.com",
    hostPattern: /^(?:[a-z0-9-]+\.)*github\.com$/i,
    sshPrefix: "git@github.com:"
  },
  gitlab: {
    id: "gitlab",
    displayName: "GitLab",
    host: "gitlab.com",
    hostPattern: /^(?:[a-z0-9-]+\.)*gitlab\.com$/i,
    sshPrefix: "git@gitlab.com:"
  },
  bitbucket: {
    id: "bitbucket",
    displayName: "Bitbucket",
    host: "bitbucket.org",
    hostPattern: /^(?:[a-z0-9-]+\.)*bitbucket\.org$/i,
    sshPrefix: "git@bitbucket.org:"
  }
};

/**
 * What a bare "owner/repo" shorthand means. GitHub, both because it's the
 * only implemented provider and because every existing caller of this
 * service is a GitHub caller — changing this would silently repoint their
 * requests.
 */
export const DEFAULT_PROVIDER_ID: ProviderId = "github";

export const PROVIDER_IDS = Object.keys(PROVIDER_HOSTS) as ProviderId[];

export function providerHost(id: ProviderId): ProviderHostSpec {
  return PROVIDER_HOSTS[id];
}

/** Maps a URL hostname to the provider that serves it, or null if unknown. */
export function providerIdForHost(hostname: string): ProviderId | null {
  const normalized = hostname.trim().toLowerCase();
  for (const spec of Object.values(PROVIDER_HOSTS)) {
    if (spec.hostPattern.test(normalized)) return spec.id;
  }
  return null;
}

/**
 * Matches an SSH shorthand ("git@gitlab.com:owner/repo.git") to its
 * provider, returning the owner/repo remainder alongside it.
 */
export function matchSshPrefix(input: string): { id: ProviderId; rest: string } | null {
  for (const spec of Object.values(PROVIDER_HOSTS)) {
    // Compare a fixed-length slice rather than lowercasing the whole
    // string first: lowercasing can change a string's length for some
    // non-ASCII characters, which would misalign the slice below.
    if (input.slice(0, spec.sshPrefix.length).toLowerCase() === spec.sshPrefix) {
      return { id: spec.id, rest: input.slice(spec.sshPrefix.length) };
    }
  }
  return null;
}

/**
 * The only clone target this service will ever hand to `git`: always https,
 * always the provider's canonical host, never anything derived from caller
 * input beyond the validated owner/repo.
 */
export function cloneUrlFor(ref: RepoRef): string {
  const spec = providerHost(ref.provider);
  return `https://${spec.host}/${ref.owner}/${ref.repo}.git`;
}

/** "github.com/octocat/hello-world" — for log lines and error messages. */
export function describeRef(ref: RepoRef): string {
  return `${providerHost(ref.provider).host}/${ref.owner}/${ref.repo}`;
}
