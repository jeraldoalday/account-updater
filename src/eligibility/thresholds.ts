import "dotenv/config";

export const KNOWN_LANGUAGES = ["TypeScript", "JavaScript", "Python", "Go", "Rust"] as const;

export type AllowedLanguage = (typeof KNOWN_LANGUAGES)[number];

export const LANGUAGE_EXTENSIONS: Record<AllowedLanguage, string[]> = {
  TypeScript: [".ts", ".tsx"],
  JavaScript: [".js", ".jsx", ".mjs", ".cjs"],
  Python: [".py"],
  Go: [".go"],
  Rust: [".rs"]
};

function isKnownLanguage(value: string): value is AllowedLanguage {
  return (KNOWN_LANGUAGES as readonly string[]).includes(value);
}

// Narrows which of the known languages count toward the primary-language
// (and, by extension, size) checks — e.g. ELIGIBLE_LANGUAGES=TypeScript,Python
// for a service that only wants to onboard those two ecosystems. Defaults to
// all known languages. An unrecognized name fails fast rather than being
// silently dropped, since a typo here would otherwise just look like every
// repo in that language is ineligible.
function loadAllowedLanguages(): readonly AllowedLanguage[] {
  const raw = process.env.ELIGIBLE_LANGUAGES?.trim();
  if (!raw) return KNOWN_LANGUAGES;

  const requested = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const unknown = requested.filter((lang) => !isKnownLanguage(lang));
  if (unknown.length > 0) {
    throw new Error(
      `Invalid configuration - ELIGIBLE_LANGUAGES contains unknown language(s): ${unknown.join(", ")}. Known languages: ${KNOWN_LANGUAGES.join(", ")}.`
    );
  }

  return requested.length > 0 ? (requested as AllowedLanguage[]) : KNOWN_LANGUAGES;
}

export const ALLOWED_LANGUAGES: readonly AllowedLanguage[] = loadAllowedLanguages();

export const THRESHOLDS = {
  minLines: 8000,
  minFiles: 50,
  // ~10 commits/day over the minimum 14-day history window.
  minCommits: 140,
  minHistoryDays: 14,
  // Active-development / "not a bulk push" heuristic, based on the calendar
  // days on which commits were authored across the commit history.
  minDistinctCommitDays: 8,
  maxSingleDayCommitShare: 0.6,
  // If a single GitHub push event landed this share (or more) of all known
  // commits at once, treat that as a strong bulk-push signal.
  maxSinglePushEventCommitShare: 0.8
};
