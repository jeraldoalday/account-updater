import type { RepoRef } from "../types";

// Mirrors GitHub's actual owner/repo naming rules. Validating against these
// (rather than accepting anything without a "/") closes off malformed values
// - e.g. a URL path segment like "@evil.com" or embedded control characters
// - well before they ever reach `git clone` or the GitHub API, instead of
// failing later with a confusing clone/API error.
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

function assertValidRef(owner: string, repo: string, original: string): RepoRef {
  if (!OWNER_PATTERN.test(owner) || !REPO_PATTERN.test(repo) || repo === "." || repo === "..") {
    throw new Error(`Could not parse a GitHub owner/repo from "${original}"`);
  }
  return { owner, repo };
}

/**
 * Accepts a GitHub repo in any of the common forms:
 *   owner/repo
 *   https://github.com/owner/repo
 *   https://github.com/owner/repo.git
 *   git@github.com:owner/repo.git
 *
 * Only ever resolves to an `https://github.com/...` clone target (see
 * `cloneUrlFor`), so this doubles as an SSRF guard: a caller cannot steer
 * the service's outbound `git clone` at an arbitrary/internal host by
 * supplying a crafted URL (e.g. embedded userinfo like
 * "https://github.com@internal-host/x/y", a non-github.com host, or a
 * non-https scheme).
 */
export function parseRepoRef(input: string): RepoRef {
  const trimmed = input.trim();

  const sshMatch = trimmed.match(/^git@github\.com:([^/]+)\/(.+?)(\.git)?$/);
  if (sshMatch) {
    return assertValidRef(sshMatch[1], sshMatch[2].replace(/\.git$/, ""), input);
  }

  const shorthandMatch = trimmed.match(/^([^/\s]+)\/([^/\s]+?)(\.git)?$/);
  if (shorthandMatch && !trimmed.includes("://")) {
    return assertValidRef(shorthandMatch[1], shorthandMatch[2], input);
  }

  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:") {
      throw new Error(`Unsupported scheme: ${url.protocol}`);
    }
    if (url.username || url.password) {
      throw new Error("URL must not contain userinfo");
    }
    if (!/(^|\.)github\.com$/.test(url.hostname)) {
      throw new Error(`Unsupported host: ${url.hostname}`);
    }
    const parts = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
    if (parts.length < 2) {
      throw new Error("URL is missing an owner and repo name");
    }
    const [owner, repoRaw] = parts;
    const repo = repoRaw.replace(/\.git$/, "");
    return assertValidRef(owner, repo, input);
  } catch {
    throw new Error(`Could not parse a GitHub owner/repo from "${input}"`);
  }
}

export function cloneUrlFor(ref: RepoRef): string {
  return `https://github.com/${ref.owner}/${ref.repo}.git`;
}
