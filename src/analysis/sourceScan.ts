import { readdir, readFile, stat } from "node:fs/promises";
import { join, extname } from "node:path";
import {
  ALLOWED_LANGUAGES,
  LANGUAGE_EXTENSIONS,
  type AllowedLanguage
} from "../eligibility/thresholds";
import type { SourceScanResult } from "../types";

const EXCLUDED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  "target", // Rust/Go build output
  "vendor",
  "venv",
  ".venv",
  "env",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  "coverage",
  ".turbo",
  ".cache",
  "bin",
  "obj",
  "third_party",
  "generated",
  ".idea",
  ".vscode"
]);

const EXCLUDED_FILE_PATTERNS = [
  /\.min\.(js|mjs|cjs|css)$/,
  /package-lock\.json$/,
  /yarn\.lock$/,
  /pnpm-lock\.yaml$/,
  /Cargo\.lock$/,
  /go\.sum$/,
  /poetry\.lock$/,
  /Pipfile\.lock$/,
  /_pb2(_grpc)?\.py$/,
  /\.pb\.go$/
];

/**
 * Files above this size are read past, not counted. A repo is untrusted
 * input of unbounded size, and `readFile(..., "utf8")` materializes the
 * whole file as a UTF-16 string - roughly twice its byte size in memory,
 * with several evaluations able to run concurrently. Two megabytes is far
 * above any hand-written source file; what actually lands above it is
 * generated code, bundled/minified output, or a data blob committed with a
 * source extension, none of which the first-party-source count should be
 * including anyway. So the cap protects memory and improves the measure at
 * the same time.
 */
const MAX_SOURCE_FILE_BYTES = 2 * 1024 * 1024;

const extensionToLanguage = new Map<string, AllowedLanguage>();
for (const lang of ALLOWED_LANGUAGES) {
  for (const ext of LANGUAGE_EXTENSIONS[lang]) {
    extensionToLanguage.set(ext, lang);
  }
}

function isExcludedFile(path: string): boolean {
  return EXCLUDED_FILE_PATTERNS.some((pattern) => pattern.test(path));
}

function countLines(content: string): number {
  if (content.length === 0) return 0;
  const lines = content.split("\n");
  // A trailing "\n" (the POSIX-normal case) produces a phantom empty final
  // element that isn't really an extra line; drop it.
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.length;
}

async function walk(dir: string, relativeTo: string, out: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    // A cloned repo is untrusted input and could commit a symlink pointing
    // outside the temp clone dir (e.g. at /etc/passwd or another absolute
    // path). `Dirent` type checks reflect the directory entry itself
    // (lstat-like) rather than the symlink target, so `isDirectory()`/
    // `isFile()` are already both false for a symlink - this check makes
    // that skip explicit and tested rather than relying on that implicit
    // behavior surviving future refactors.
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      await walk(join(dir, entry.name), relativeTo, out);
    } else if (entry.isFile()) {
      const full = join(dir, entry.name);
      const rel = full.slice(relativeTo.length + 1);
      if (isExcludedFile(rel)) continue;
      out.push(full);
    }
  }
}

/**
 * Walks a cloned repo's working tree and counts lines/files of first-party
 * source in the eligible languages, skipping vendored/build/generated paths
 * and any single file over MAX_SOURCE_FILE_BYTES.
 */
export async function scanSource(rootDir: string): Promise<SourceScanResult> {
  const allFiles: string[] = [];
  await walk(rootDir, rootDir, allFiles);

  const stats = new Map<AllowedLanguage, { lines: number; files: number }>();
  let skippedLargeFiles = 0;

  for (const filePath of allFiles) {
    const lang = extensionToLanguage.get(extname(filePath));
    if (!lang) continue;

    let content: string;
    try {
      // Checked before reading, not after: the point is to never hold the
      // file in memory at all.
      const { size } = await stat(filePath);
      if (size > MAX_SOURCE_FILE_BYTES) {
        skippedLargeFiles++;
        continue;
      }
      content = await readFile(filePath, "utf8");
    } catch {
      continue; // unreadable/binary despite the extension; skip
    }

    const current = stats.get(lang) ?? { lines: 0, files: 0 };
    current.lines += countLines(content);
    current.files += 1;
    stats.set(lang, current);
  }

  const byLanguage = [...stats.entries()]
    .map(([language, s]) => ({ language, lines: s.lines, files: s.files }))
    .sort((a, b) => b.lines - a.lines);

  const totalLines = byLanguage.reduce((sum, s) => sum + s.lines, 0);
  const totalFiles = byLanguage.reduce((sum, s) => sum + s.files, 0);
  const primaryLanguage = byLanguage[0]?.language ?? null;

  return { byLanguage, totalLines, totalFiles, primaryLanguage, skippedLargeFiles };
}
