import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  compareVersionsDesc,
  parseChangelog,
  readChangelog,
  CHANGELOG_PATH
} from "./helpers/changelog";
import { version } from "../src/version";

const KNOWN_CATEGORIES = ["Added", "Changed", "Deprecated", "Removed", "Fixed", "Security"];

describe("parseChangelog", () => {
  it("reads a released section's version and date", () => {
    const sections = parseChangelog("## [1.2.0] - 2026-08-20\n\n### Added\n\n- a thing\n");
    expect(sections).toEqual([{ version: "1.2.0", date: "2026-08-20", categories: ["Added"] }]);
  });

  it("reads an unreleased section, which has no date", () => {
    const [section] = parseChangelog("## [Unreleased]\n\n### Fixed\n\n- a thing\n");
    expect(section).toEqual({ version: "Unreleased", categories: ["Fixed"] });
  });

  it("attributes each category to the section it appears under", () => {
    const sections = parseChangelog(
      ["## [Unreleased]", "### Added", "## [0.9.0] - 2026-01-01", "### Fixed", "### Security"].join(
        "\n"
      )
    );
    expect(sections.map((s) => s.categories)).toEqual([["Added"], ["Fixed", "Security"]]);
  });

  it("ignores prose headings that aren't version sections", () => {
    expect(parseChangelog("# Changelog\n\nSome intro text.\n")).toEqual([]);
  });
});

describe("CHANGELOG.md", () => {
  const sections = readChangelog();

  it("has at least one section", () => {
    expect(sections.length).toBeGreaterThan(0);
  });

  it("gives every released version a date, and none to Unreleased", () => {
    for (const section of sections) {
      if (section.version === "Unreleased") {
        expect(section.date).toBeUndefined();
      } else {
        expect(section.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    }
  });

  it("lists releases newest-first", () => {
    const released = sections.filter((s) => s.version !== "Unreleased").map((s) => s.version);
    expect(released).toEqual([...released].sort(compareVersionsDesc));
  });

  it("uses only Keep a Changelog categories", () => {
    // A one-off "### Misc" heading is how a changelog stops being
    // skimmable; the vocabulary is small on purpose.
    for (const section of sections) {
      for (const category of section.categories) {
        expect(KNOWN_CATEGORIES).toContain(category);
      }
    }
  });

  it("has somewhere for the current package version's changes to live", () => {
    // Either this version is already written up, or an Unreleased section
    // is open for it. Bumping package.json without touching the changelog
    // fails here - which is the point, since that's exactly when it gets
    // forgotten.
    const versions = sections.map((s) => s.version);
    expect(versions.includes(version) || versions.includes("Unreleased")).toBe(true);
  });

  it("declares its format, so the conventions aren't folklore", () => {
    const markdown = readFileSync(CHANGELOG_PATH, "utf8");
    expect(markdown).toContain("Keep a Changelog");
    expect(markdown).toContain("semantic versioning");
  });

  it("is where the repo root expects it", () => {
    expect(CHANGELOG_PATH).toBe(join(__dirname, "..", "CHANGELOG.md"));
  });
});
