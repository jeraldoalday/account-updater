import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { authenticatedCloneUrl, describeRef } from "../providers/hosts";
import type { RepoRef } from "../types";

const execFileAsync = promisify(execFile);

/**
 * Shallow-clones a repo's default branch into a temp directory for
 * inspecting its current file tree. Only the latest snapshot is needed here;
 * commit history comes from the provider's API instead (a full clone would
 * be far more expensive for no extra benefit at this check).
 *
 * Provider-agnostic by construction: the clone target and the token
 * placeholder username both come from the ref's provider host entry, so
 * this needs no change when a second forge is implemented.
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
        ["clone", "--depth", "1", "--quiet", authenticatedCloneUrl(ref, token), dir],
        { timeout: 120_000 }
      );
    } catch (err) {
      // Strip the token out of any error message before it can propagate
      // (e.g. into an HTTP response or log line). Both forms have to be
      // scrubbed: git echoes back the URL it was given, which contains the
      // percent-encoded token, while other failures can surface the raw
      // value.
      let message = String((err as Error).message);
      if (token) {
        message = message.replaceAll(token, "***").replaceAll(encodeURIComponent(token), "***");
      }
      throw new Error(`git clone failed for ${describeRef(ref)}: ${message}`);
    }
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
