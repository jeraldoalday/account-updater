export const ALLOWED_LANGUAGES = ["TypeScript", "JavaScript", "Python", "Go", "Rust"] as const;

export type AllowedLanguage = (typeof ALLOWED_LANGUAGES)[number];

export const LANGUAGE_EXTENSIONS: Record<AllowedLanguage, string[]> = {
  TypeScript: [".ts", ".tsx"],
  JavaScript: [".js", ".jsx", ".mjs", ".cjs"],
  Python: [".py"],
  Go: [".go"],
  Rust: [".rs"]
};

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
