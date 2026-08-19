import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface ChangelogSection {
  /** "Unreleased", or a semver string like "1.0.0". */
  version: string;
  /** ISO date the version was released; absent for "Unreleased". */
  date?: string;
  /** "Added" / "Changed" / "Fixed" ... in the order they appear. */
  categories: string[];
}

export const CHANGELOG_PATH = join(__dirname, "..", "..", "CHANGELOG.md");

/**
 * Keep a Changelog puts each release under `## [version] - date`, with
 * `### Category` groups beneath it. Parsing that structure is what lets a
 * test assert the file is actually maintained - that a version bump came
 * with an entry, that versions run newest-first, that no release lost its
 * date - rather than merely that a CHANGELOG.md file exists.
 */
export function parseChangelog(markdown: string): ChangelogSection[] {
  const sections: ChangelogSection[] = [];

  for (const line of markdown.split("\n")) {
    const heading = line.match(/^##\s+\[([^\]]+)\](?:\s+-\s+(\S+))?\s*$/);
    if (heading) {
      sections.push({
        version: heading[1],
        ...(heading[2] ? { date: heading[2] } : {}),
        categories: []
      });
      continue;
    }

    const category = line.match(/^###\s+(.+?)\s*$/);
    if (category && sections.length > 0) {
      sections[sections.length - 1].categories.push(category[1]);
    }
  }

  return sections;
}

export function readChangelog(path: string = CHANGELOG_PATH): ChangelogSection[] {
  return parseChangelog(readFileSync(path, "utf8"));
}

/** Descending semver comparison, for asserting newest-first ordering. */
export function compareVersionsDesc(a: string, b: string): number {
  const parse = (v: string) => v.split(".").map((part) => Number.parseInt(part, 10));
  const [aMajor, aMinor, aPatch] = parse(a);
  const [bMajor, bMinor, bPatch] = parse(b);
  return bMajor - aMajor || bMinor - aMinor || bPatch - aPatch;
}
