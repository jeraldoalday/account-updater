import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { cloneUrlFor } from "../utils/repoUrl";
import type { RepoRef } from "../types";

const execFileAsync = promisify(execFile);

function authenticatedUrl(ref: RepoRef, token?: string): string {
  const url = cloneUrlFor(ref);
  if (!token) return url;
  return url.replace("https://", `https://x-access-token:${token}@`);
}

/**
 * Shallow-clones a repo's default branch into a temp directory for
 * inspecting its current file tree. Only the latest snapshot is needed here;
 * commit history is fetched from the GitHub API instead (a full clone would
 * be far more expensive for no extra benefit at this check).
 */
export async function withShallowClone<T>(
  ref: RepoRef,
  token: string | undefined,
  fn: (dir: string) => Promise<T>
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "account-updater-"));
  try {
    try {
      await execFileAsync(
        "git",
        ["clone", "--depth", "1", "--quiet", authenticatedUrl(ref, token), dir],
        { timeout: 120_000 }
      );
    } catch (err) {
      // Strip the token out of any error message before it can propagate
      // (e.g. into an HTTP response or log line).
      const message = token
        ? String((err as Error).message).replaceAll(token, "***")
        : String((err as Error).message);
      throw new Error(`git clone failed for ${ref.owner}/${ref.repo}: ${message}`);
    }
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
