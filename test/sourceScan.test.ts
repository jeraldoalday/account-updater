import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanSource } from "../src/analysis/sourceScan";

describe("scanSource", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "source-scan-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("counts lines and files for eligible-language source, excluding vendor dirs", async () => {
    await writeFile(join(dir, "index.ts"), "a\nb\nc\n");
    await writeFile(join(dir, "util.ts"), "a\nb\n");

    await mkdir(join(dir, "node_modules", "dep"), { recursive: true });
    await writeFile(join(dir, "node_modules", "dep", "index.js"), "x\ny\nz\nw\n");

    const result = await scanSource(dir);

    expect(result.totalFiles).toBe(2);
    expect(result.totalLines).toBe(5); // 3 + 2, node_modules excluded
    expect(result.primaryLanguage).toBe("TypeScript");
  });

  it("excludes .tox and .eggs directories from the scan", async () => {
    await writeFile(join(dir, "main.py"), "a\nb\nc\n");

    await mkdir(join(dir, ".tox", "py311", "lib"), { recursive: true });
    await writeFile(join(dir, ".tox", "py311", "lib", "installed.py"), "x\ny\n");

    await mkdir(join(dir, ".eggs", "somepkg"), { recursive: true });
    await writeFile(join(dir, ".eggs", "somepkg", "vendored.py"), "x\ny\nz\n");

    const result = await scanSource(dir);

    expect(result.totalFiles).toBe(1);
    expect(result.totalLines).toBe(3);
  });

  it("ignores lockfiles and minified files", async () => {
    await writeFile(join(dir, "app.js"), "a\nb\n");
    await writeFile(join(dir, "app.min.js"), "a".repeat(5000));
    await writeFile(join(dir, "bundle.min.mjs"), "a".repeat(5000));
    await writeFile(join(dir, "bundle.min.cjs"), "a".repeat(5000));
    await writeFile(join(dir, "package-lock.json"), "{}");

    const result = await scanSource(dir);

    expect(result.totalFiles).toBe(1);
    expect(result.byLanguage[0]).toEqual({ language: "JavaScript", lines: 2, files: 1 });
  });

  it("counts .mts and .cts files as TypeScript", async () => {
    await writeFile(join(dir, "loader.mts"), "a\nb\nc\n");
    await writeFile(join(dir, "config.cts"), "a\nb\n");

    const result = await scanSource(dir);

    expect(result.totalFiles).toBe(2);
    expect(result.byLanguage[0]).toEqual({ language: "TypeScript", lines: 5, files: 2 });
  });

  it("picks the language with the most lines as primary", async () => {
    await writeFile(join(dir, "main.py"), Array(20).fill("x").join("\n"));
    await writeFile(join(dir, "script.js"), "x\n");

    const result = await scanSource(dir);

    expect(result.primaryLanguage).toBe("Python");
  });

  it("returns null primary language when nothing matches", async () => {
    await writeFile(join(dir, "README.md"), "# hello\n");

    const result = await scanSource(dir);

    expect(result.primaryLanguage).toBeNull();
    expect(result.totalFiles).toBe(0);
  });

  it("does not follow a symlinked file pointing outside the scanned tree", async () => {
    const outsideDir = await mkdtemp(join(tmpdir(), "source-scan-outside-"));
    try {
      const outsideFile = join(outsideDir, "secret.ts");
      await writeFile(outsideFile, Array(50).fill("secret line").join("\n"));
      await writeFile(join(dir, "real.ts"), "a\nb\n");
      await symlink(outsideFile, join(dir, "link.ts"));

      const result = await scanSource(dir);

      expect(result.totalFiles).toBe(1);
      expect(result.totalLines).toBe(2);
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  it("does not descend into a symlinked directory pointing outside the scanned tree", async () => {
    const outsideDir = await mkdtemp(join(tmpdir(), "source-scan-outside-"));
    try {
      await writeFile(join(outsideDir, "other.ts"), "a\nb\nc\n");
      await writeFile(join(dir, "real.ts"), "a\n");
      await symlink(outsideDir, join(dir, "linked-dir"));

      const result = await scanSource(dir);

      expect(result.totalFiles).toBe(1);
      expect(result.totalLines).toBe(1);
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  it("skips a source file too large to be plausible first-party source", async () => {
    // A 3 MB generated/bundled file with a real source extension: counting
    // it would both distort the line count and, on a big enough file, load
    // the whole thing into memory as a UTF-16 string.
    await writeFile(join(dir, "app.ts"), "a\nb\nc\n");
    await writeFile(join(dir, "generated.ts"), "x\n".repeat(1_500_000));

    const result = await scanSource(dir);

    expect(result.totalFiles).toBe(1);
    expect(result.totalLines).toBe(3);
    expect(result.skippedLargeFiles).toBe(1);
  });

  it("reports no skipped files for an ordinary repo", async () => {
    await writeFile(join(dir, "index.ts"), "a\nb\n");
    const result = await scanSource(dir);
    expect(result.skippedLargeFiles).toBe(0);
  });

  it("counts a file just under the size cap normally", async () => {
    // Guards the boundary in the right direction: the cap must not start
    // excluding large-but-legitimate source files.
    await writeFile(join(dir, "big.ts"), "x\n".repeat(1_000_000)); // ~2 MB
    const result = await scanSource(dir);
    expect(result.skippedLargeFiles).toBe(0);
    expect(result.totalFiles).toBe(1);
  });
});
