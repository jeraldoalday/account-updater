import { readFileSync } from "node:fs";
import { join } from "node:path";

interface PackageJson {
  version: string;
}

function readVersion(): string {
  try {
    const pkgPath = join(__dirname, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as PackageJson;
    return pkg.version;
  } catch {
    return "unknown";
  }
}

export const version = readVersion();
