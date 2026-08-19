import {
  DEFAULT_PROVIDER_ID,
  matchSshPrefix,
  providerIdForHost,
  type ProviderId
} from "../providers/hosts";
import type { RepoRef } from "../types";

// Mirrors GitHub's actual owner/repo naming rules, and is applied to every
// provider: it's the strictest of the set, so it can only ever reject a
// name a laxer forge would allow (GitLab subgroups, for instance, which
// this service doesn't support yet either way). Validating against these
// - rather than accepting anything without a "/" - closes off malformed
// values, e.g. a URL path segment like "@evil.com" or embedded control
// characters, well before they ever reach `git clone` or a provider API,
// instead of failing later with a confusing clone/API error.
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

function parseError(input: string): Error {
  return new Error(`Could not parse an owner/repo from "${input}"`);
}

function assertValidRef(
  provider: ProviderId,
  owner: string,
  repo: string,
  original: string
): RepoRef {
  if (!OWNER_PATTERN.test(owner) || !REPO_PATTERN.test(repo) || repo === "." || repo === "..") {
    throw parseError(original);
  }
  return { provider, owner, repo };
}

/**
 * Accepts a repo reference in any of the common forms:
 *   owner/repo                          (assumed to be on DEFAULT_PROVIDER_ID)
 *   https://github.com/owner/repo
 *   https://gitlab.com/owner/repo.git
 *   git@bitbucket.org:owner/repo.git
 *
 * The returned ref always names a known provider, and clone targets are
 * rebuilt from that provider's canonical host (see `cloneUrlFor`), so this
 * doubles as an SSRF guard: a caller cannot steer the service's outbound
 * `git clone` at an arbitrary/internal host by supplying a crafted URL
 * (e.g. embedded userinfo like "https://github.com@internal-host/x/y", an
 * unknown host, or a non-https scheme).
 *
 * Parsing a provider is deliberately separate from *supporting* it: a
 * GitLab URL parses fine here and is rejected later, by the provider
 * registry, with a message that says so.
 */
export function parseRepoRef(input: string): RepoRef {
  const trimmed = input.trim();

  const ssh = matchSshPrefix(trimmed);
  if (ssh) {
    const sshMatch = ssh.rest.match(/^([^/]+)\/(.+?)(\.git)?$/);
    if (!sshMatch) throw parseError(input);
    return assertValidRef(ssh.id, sshMatch[1], sshMatch[2].replace(/\.git$/, ""), input);
  }

  const shorthandMatch = trimmed.match(/^([^/\s]+)\/([^/\s]+?)(\.git)?$/);
  if (shorthandMatch && !trimmed.includes("://")) {
    return assertValidRef(DEFAULT_PROVIDER_ID, shorthandMatch[1], shorthandMatch[2], input);
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw parseError(input);
  }

  if (url.protocol !== "https:") {
    throw new Error(`Unsupported scheme in "${input}": only https:// URLs are accepted`);
  }
  if (url.username || url.password) {
    throw new Error(`Unsupported URL "${input}": it must not contain userinfo`);
  }

  const provider = providerIdForHost(url.hostname);
  if (!provider) {
    throw new Error(`Unsupported host "${url.hostname}": not a known code host`);
  }

  const parts = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
  if (parts.length < 2) throw parseError(input);

  const [owner, repoRaw] = parts;
  return assertValidRef(provider, owner, repoRaw.replace(/\.git$/, ""), input);
}

export { cloneUrlFor, describeRef, providerHost } from "../providers/hosts";
