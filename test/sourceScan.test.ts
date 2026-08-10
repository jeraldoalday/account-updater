import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

  it("ignores lockfiles and minified files", async () => {
    await writeFile(join(dir, "app.js"), "a\nb\n");
    await writeFile(join(dir, "app.min.js"), "a".repeat(5000));
    await writeFile(join(dir, "package-lock.json"), "{}");

    const result = await scanSource(dir);

    expect(result.totalFiles).toBe(1);
    expect(result.byLanguage[0]).toEqual({ language: "JavaScript", lines: 2, files: 1 });
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
});
