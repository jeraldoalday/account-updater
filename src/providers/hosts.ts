import type { RepoRef } from "../types";

/**
 * The forges this service knows how to *name*.
 *
 * Naming a forge and evaluating one are separate concerns, and this table
 * is the first of the two: it is what turns a pasted URL into a known
 * host, which is where the SSRF guard lives. Which of these can actually
 * be evaluated is the registry's business (see
 * `src/providers/registry.ts`) - all three can today, and a forge added
 * here before its client exists still parses into a precise "not
 * supported yet" answer rather than a confusing parse failure.
 */
export type ProviderId = "github" | "gitlab" | "bitbucket";

export interface ProviderHostSpec {
  id: ProviderId;
  displayName: string;
  /** Canonical host, used to build clone URLs. */
  host: string;
  /**
   * Canonical host for the forge's REST API, which is not always the host
   * repos are cloned from: GitLab serves `/api/v4` from gitlab.com itself,
   * while Bitbucket puts its API on api.bitbucket.org and GitHub on
   * api.github.com.
   *
   * Kept in the host table rather than as a constant inside each client so
   * that every outbound host this service can reach is declared in one
   * place - the same table the SSRF guard is built from. A client that
   * assembles its own base URL is a client that can be pointed somewhere
   * else by a future edit without anyone noticing.
   */
  apiHost: string;
  /**
   * Hostnames accepted when parsing a repo URL: the canonical host and its
   * subdomains, nothing else. Anchored at both ends so a lookalike host
   * ("github.com.evil.test", "notgithub.com") can't slip through — this is
   * the SSRF guard, so keep it strict.
   */
  hostPattern: RegExp;
  /** SSH shorthand prefix, e.g. "git@github.com:". */
  sshPrefix: string;
  /**
   * Username to pair with a token when cloning over https. Each forge
   * expects its own fixed placeholder here and rejects the others, so this
   * is per-provider data rather than a constant.
   */
  cloneTokenUser: string;
  /**
   * Whether a project can live under nested groups, so that the part of
   * the path before the project name may itself contain slashes
   * ("group/subgroup/team/project"). True only for GitLab.
   *
   * This is not cosmetic: on a forge without nesting, everything after the
   * second path segment is a page within the repo ("/tree/main"), and on
   * GitLab it is part of the project's identity. Reading a GitLab URL with
   * the GitHub rule silently evaluates a different project than the one
   * asked about.
   */
  supportsNestedNamespaces: boolean;
}

export const PROVIDER_HOSTS: Record<ProviderId, ProviderHostSpec> = {
  github: {
    id: "github",
    displayName: "GitHub",
    host: "github.com",
    // Only for completeness: the GitHub path goes through Octokit, which
    // knows its own base URL. Declared so the table is a full account of
    // where this service talks to.
    apiHost: "api.github.com",
    hostPattern: /^(?:[a-z0-9-]+\.)*github\.com$/i,
    sshPrefix: "git@github.com:",
    cloneTokenUser: "x-access-token",
    supportsNestedNamespaces: false
  },
  gitlab: {
    id: "gitlab",
    displayName: "GitLab",
    host: "gitlab.com",
    apiHost: "gitlab.com",
    hostPattern: /^(?:[a-z0-9-]+\.)*gitlab\.com$/i,
    sshPrefix: "git@gitlab.com:",
    cloneTokenUser: "oauth2",
    supportsNestedNamespaces: true
  },
  bitbucket: {
    id: "bitbucket",
    displayName: "Bitbucket",
    host: "bitbucket.org",
    apiHost: "api.bitbucket.org",
    hostPattern: /^(?:[a-z0-9-]+\.)*bitbucket\.org$/i,
    sshPrefix: "git@bitbucket.org:",
    cloneTokenUser: "x-token-auth",
    supportsNestedNamespaces: false
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

/**
 * The clone URL with a token embedded as userinfo, using whichever
 * placeholder username the provider expects. The token is percent-encoded
 * because git decodes userinfo before using it, so an unencoded "/" or "@"
 * in a token would otherwise corrupt the URL.
 */
export function authenticatedCloneUrl(ref: RepoRef, token?: string): string {
  const url = cloneUrlFor(ref);
  if (!token) return url;
  const user = providerHost(ref.provider).cloneTokenUser;
  return url.replace("https://", `https://${user}:${encodeURIComponent(token)}@`);
}

/**
 * The origin a provider's REST API is served from. The only base URL a
 * client should ever build a request on: always https, always a host from
 * the table above, never anything derived from caller input or from a URL
 * an API response handed back.
 */
export function apiBaseUrl(id: ProviderId): string {
  return `https://${providerHost(id).apiHost}`;
}

/** "github.com/octocat/hello-world" — for log lines and error messages. */
export function describeRef(ref: RepoRef): string {
  return `${providerHost(ref.provider).host}/${ref.owner}/${ref.repo}`;
}

/**
 * "GitHub", "GitLab" — the forge's name as a person writes it, for an
 * error message a caller reads. Distinct from `describeRef`, which names
 * the repo: a message about a quota is about the forge, not about one
 * project on it.
 */
export function providerDisplayName(id: ProviderId): string {
  return providerHost(id).displayName;
}
