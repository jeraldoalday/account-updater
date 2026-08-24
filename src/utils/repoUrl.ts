import {
  DEFAULT_PROVIDER_ID,
  matchSshPrefix,
  providerHost,
  providerIdForHost,
  type ProviderId
} from "../providers/hosts";
import type { RepoRef } from "../types";

// Mirrors GitHub's actual owner/repo naming rules, and is applied to every
// provider whose namespace is a single segment: it's the strictest of the
// set, so it can only ever reject a name a laxer forge would allow.
// (GitLab, whose groups nest, is validated segment by segment instead -
// see isValidNamespace.) Validating against these
// - rather than accepting anything without a "/" - closes off malformed
// values, e.g. a URL path segment like "@evil.com" or embedded control
// characters, well before they ever reach `git clone` or a provider API,
// instead of failing later with a confusing clone/API error.
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

// One segment of a nested namespace, for the forges that have them. Looser
// than OWNER_PATTERN because GitLab group paths legitimately contain dots
// and underscores, and stricter than "anything": each segment must still
// start alphanumeric and contain no slash, so a crafted value cannot add
// path segments, escape upward, or reach a host other than the provider's.
const NAMESPACE_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
const MAX_NAMESPACE_DEPTH = 20; // GitLab's own limit on group nesting

function parseError(input: string): Error {
  return new Error(`Could not parse an owner/repo from "${input}"`);
}

/**
 * Validates the namespace a project sits in. For most forges that is a
 * single user or organization name; for GitLab it can be a chain of nested
 * groups, and each link in the chain is checked individually so the
 * guarantee stays the same either way - no slashes beyond the ones we put
 * there, no "." or "..", nothing that could turn into a different path
 * once it is pasted into a clone URL or an API request.
 */
function isValidNamespace(provider: ProviderId, owner: string): boolean {
  if (!providerHost(provider).supportsNestedNamespaces) return OWNER_PATTERN.test(owner);

  const segments = owner.split("/");
  if (segments.length === 0 || segments.length > MAX_NAMESPACE_DEPTH) return false;
  return segments.every(
    (segment) => NAMESPACE_SEGMENT_PATTERN.test(segment) && segment !== "." && segment !== ".."
  );
}

function assertValidRef(
  provider: ProviderId,
  owner: string,
  repo: string,
  original: string
): RepoRef {
  if (
    !isValidNamespace(provider, owner) ||
    !REPO_PATTERN.test(repo) ||
    repo === "." ||
    repo === ".."
  ) {
    throw parseError(original);
  }
  return { provider, owner, repo };
}

/**
 * Splits a URL path into the namespace and the project name.
 *
 * On a forge without nested groups the project is the second segment and
 * anything after it is a page within the repo ("/tree/main"), so the extra
 * segments are dropped. On GitLab they are part of the project's identity,
 * so all but the last belong to the namespace - and GitLab separates its
 * own in-project pages with a literal "/-/" segment, which is where the
 * path stops meaning "project" and starts meaning "view of the project".
 */
function splitProjectPath(provider: ProviderId, parts: readonly string[]): [string, string] | null {
  if (!providerHost(provider).supportsNestedNamespaces) {
    return parts.length >= 2 ? [parts[0], parts[1]] : null;
  }

  const dashIndex = parts.indexOf("-");
  const pathParts = dashIndex === -1 ? [...parts] : parts.slice(0, dashIndex);
  if (pathParts.length < 2) return null;

  const repo = pathParts[pathParts.length - 1];
  return [pathParts.slice(0, -1).join("/"), repo];
}

/**
 * Accepts a repo reference in any of the common forms:
 *   owner/repo                          (assumed to be on DEFAULT_PROVIDER_ID)
 *   https://github.com/owner/repo
 *   https://gitlab.com/group/subgroup/repo.git
 *   https://gitlab.com/group/repo/-/tree/main
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
    const sshParts = ssh.rest.replace(/\.git$/, "").split("/");
    const sshSplit = splitProjectPath(ssh.id, sshParts);
    if (!sshSplit) throw parseError(input);
    return assertValidRef(ssh.id, sshSplit[0], sshSplit[1], input);
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
  const split = splitProjectPath(provider, parts);
  if (!split) throw parseError(input);

  const [owner, repoRaw] = split;
  return assertValidRef(provider, owner, repoRaw.replace(/\.git$/, ""), input);
}

export { cloneUrlFor, describeRef, providerHost } from "../providers/hosts";
