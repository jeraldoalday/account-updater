import type { RepoRef } from "../types";

/**
 * Accepts a GitHub repo in any of the common forms:
 *   owner/repo
 *   https://github.com/owner/repo
 *   https://github.com/owner/repo.git
 *   git@github.com:owner/repo.git
 */
export function parseRepoRef(input: string): RepoRef {
  const trimmed = input.trim();

  const sshMatch = trimmed.match(/^git@github\.com:([^/]+)\/(.+?)(\.git)?$/);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }

  const shorthandMatch = trimmed.match(/^([^/\s]+)\/([^/\s]+?)(\.git)?$/);
  if (shorthandMatch && !trimmed.includes("://")) {
    return { owner: shorthandMatch[1], repo: shorthandMatch[2] };
  }

  try {
    const url = new URL(trimmed);
    if (!/(^|\.)github\.com$/.test(url.hostname)) {
      throw new Error(`Unsupported host: ${url.hostname}`);
    }
    const parts = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
    if (parts.length < 2) {
      throw new Error("URL is missing an owner and repo name");
    }
    const [owner, repoRaw] = parts;
    const repo = repoRaw.replace(/\.git$/, "");
    return { owner, repo };
  } catch {
    throw new Error(`Could not parse a GitHub owner/repo from "${input}"`);
  }
}

export function cloneUrlFor(ref: RepoRef): string {
  return `https://github.com/${ref.owner}/${ref.repo}.git`;
}
