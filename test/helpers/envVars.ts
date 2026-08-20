import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const ENV_EXAMPLE_PATH = join(__dirname, "..", "..", ".env.example");
export const SRC_DIR = join(__dirname, "..", "..", "src");

/**
 * Variables the service itself never reads: they configure a CLI, so
 * `.env.example` - which documents how to run the *service* - is the wrong
 * place for them. Listed here rather than skipped silently, so adding one
 * is a deliberate act.
 */
export const CLI_ONLY_ENV_VARS = ["SMOKE_URL", "SMOKE_API_KEY"];

/** Every `NAME=` key documented in .env.example, in file order. */
export function parseEnvExample(contents: string): string[] {
  const names: string[] = [];
  for (const line of contents.split("\n")) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=/);
    if (match) names.push(match[1]);
  }
  return names;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

/**
 * Every environment variable the source actually reads, whether through
 * config.ts's `optionalEnv()` helper or `process.env` directly.
 *
 * Deliberately a text scan: the point is to catch a variable that was
 * added to the code and never written down (or documented and then
 * renamed), and any mechanism clever enough to resolve them at runtime
 * would only see the ones the current environment happens to set.
 */
export function envVarsUsedInSource(dir: string = SRC_DIR): string[] {
  const found = new Set<string>();

  for (const file of sourceFiles(dir)) {
    const contents = readFileSync(file, "utf8");
    for (const match of contents.matchAll(/optionalEnv\("([A-Z][A-Z0-9_]*)"\)/g)) {
      found.add(match[1]);
    }
    for (const match of contents.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) {
      found.add(match[1]);
    }
    for (const match of contents.matchAll(/process\.env\["([A-Z][A-Z0-9_]*)"\]/g)) {
      found.add(match[1]);
    }
  }

  return [...found].sort();
}

export function readEnvExample(path: string = ENV_EXAMPLE_PATH): string[] {
  return parseEnvExample(readFileSync(path, "utf8"));
}

/** The `NAME=value` pairs as written, for checking what was left filled in. */
export function parseEnvExampleValues(contents: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of contents.split("\n")) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (match) values[match[1]] = match[2].trim();
  }
  return values;
}

export function readEnvExampleValues(path: string = ENV_EXAMPLE_PATH): Record<string, string> {
  return parseEnvExampleValues(readFileSync(path, "utf8"));
}
