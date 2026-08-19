import { afterEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.fn();

// promisify() looks for util.promisify.custom, so hand it a callback-style
// mock rather than trying to intercept the promisified function.
vi.mock("node:child_process", () => ({
  execFile: (
    file: string,
    args: string[],
    options: unknown,
    cb: (err: Error | null, out: { stdout: string; stderr: string }) => void
  ) => {
    try {
      execFileMock(file, args, options);
      cb(null, { stdout: "", stderr: "" });
    } catch (err) {
      cb(err as Error, { stdout: "", stderr: "" });
    }
  }
}));

const { withShallowClone } = await import("../src/clone/tempClone");

const githubRef = { provider: "github" as const, owner: "octocat", repo: "hello" };

afterEach(() => {
  execFileMock.mockReset();
});

function cloneArgs(): string[] {
  return execFileMock.mock.calls[0][1] as string[];
}

describe("withShallowClone", () => {
  it("shallow-clones the ref's provider URL into a fresh temp directory", async () => {
    const dir = await withShallowClone(githubRef, undefined, async (d) => d);

    const args = cloneArgs();
    expect(args.slice(0, 4)).toEqual(["clone", "--depth", "1", "--quiet"]);
    expect(args[4]).toBe("https://github.com/octocat/hello.git");
    expect(args[5]).toBe(dir);
  });

  it("embeds a token using the placeholder username the provider expects", async () => {
    await withShallowClone(githubRef, "ghs_secret", async () => undefined);
    expect(cloneArgs()[4]).toBe("https://x-access-token:ghs_secret@github.com/octocat/hello.git");

    execFileMock.mockReset();
    const gitlabRef = { provider: "gitlab" as const, owner: "octocat", repo: "hello" };
    await withShallowClone(gitlabRef, "glpat_secret", async () => undefined);
    expect(cloneArgs()[4]).toBe("https://oauth2:glpat_secret@gitlab.com/octocat/hello.git");
  });

  it("percent-encodes a token so reserved characters can't corrupt the URL", async () => {
    // An unencoded "@" would make git read a different host entirely.
    await withShallowClone(githubRef, "tok/en@x", async () => undefined);
    const url = new URL(cloneArgs()[4]);
    expect(url.hostname).toBe("github.com");
    expect(decodeURIComponent(url.password)).toBe("tok/en@x");
  });

  it("redacts the token from clone failure messages, encoded or raw", async () => {
    execFileMock.mockImplementation(() => {
      throw new Error(
        "fatal: could not read https://x-access-token:tok%2Fen@github.com/... (tok/en)"
      );
    });

    // Asserted by inspecting the message rather than with rejects.not,
    // which passes vacuously for a promise that does reject.
    const message = await withShallowClone(githubRef, "tok/en", async () => undefined).then(
      () => "did not throw",
      (err: Error) => err.message
    );

    expect(message).toContain("***");
    expect(message).not.toContain("tok/en");
    expect(message).not.toContain("tok%2Fen");
  });

  it("identifies the repo by host in the failure message", async () => {
    execFileMock.mockImplementation(() => {
      throw new Error("repository not found");
    });

    await expect(withShallowClone(githubRef, undefined, async () => undefined)).rejects.toThrow(
      /git clone failed for github\.com\/octocat\/hello/
    );
  });

  it("removes the temp directory when the callback throws", async () => {
    const { existsSync } = await import("node:fs");
    let capturedDir = "";

    await expect(
      withShallowClone(githubRef, undefined, async (dir) => {
        capturedDir = dir;
        throw new Error("scan blew up");
      })
    ).rejects.toThrow("scan blew up");

    expect(capturedDir).not.toBe("");
    expect(existsSync(capturedDir)).toBe(false);
  });

  it("removes the temp directory when the clone itself fails", async () => {
    const { readdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const before = readdirSync(tmpdir()).filter((n) => n.startsWith("account-updater-")).length;

    execFileMock.mockImplementation(() => {
      throw new Error("boom");
    });
    await expect(withShallowClone(githubRef, undefined, async () => undefined)).rejects.toThrow();

    const after = readdirSync(tmpdir()).filter((n) => n.startsWith("account-updater-")).length;
    expect(after).toBe(before);
  });
});
