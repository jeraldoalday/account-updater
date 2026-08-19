import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { renderCollectionJson } from "../docs/postmanCollection";

/**
 * Writes the Postman/Insomnia collection derived from the OpenAPI spec.
 *
 * The output is committed to the repo so someone can import it straight
 * from a clone (or from GitHub) without installing and running anything
 * first; `test/postmanCollection.test.ts` fails if the committed copy has
 * drifted from what this would generate, which is what keeps that
 * convenience honest.
 *
 * Usage: npm run collection [-- <output-path>]
 */
export const DEFAULT_OUTPUT_PATH = join("docs", "postman_collection.json");

export function writeCollection(outputPath: string): string {
  const target = resolve(outputPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, renderCollectionJson(), "utf8");
  return target;
}

function main(): void {
  const outputPath = process.argv[2] ?? DEFAULT_OUTPUT_PATH;
  const written = writeCollection(outputPath);
  console.log(`Wrote ${written}`);
}

if (require.main === module) {
  main();
}
