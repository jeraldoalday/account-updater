// Detects low-information commit messages: single-word placeholders, bare
// sequence numbers, and other templated text that tools generating fake
// commit history tend to reuse verbatim across hundreds of commits. A real
// message can legitimately say "wip" or "fix" once in a while - the signal
// that matters is how often a sample leans on these, not any single hit.
const GENERIC_MESSAGE_PATTERNS: RegExp[] = [
  /^wip$/i,
  /^fix(es|ed)?$/i,
  /^update(d|s)?$/i,
  /^change(s|d)?$/i,
  /^misc$/i,
  /^stuff$/i,
  /^test(ing)?$/i,
  /^\.+$/,
  /^commit(\s*#?\d+)?$/i,
  /^(day|step|part)\s*#?\d+$/i,
  /^[a-z]$/i
];

export function normalizeCommitMessage(message: string): string {
  return message.trim().split("\n")[0].trim().toLowerCase();
}

export function isGenericCommitMessage(message: string): boolean {
  const normalized = normalizeCommitMessage(message);
  if (normalized.length === 0) return true;
  return GENERIC_MESSAGE_PATTERNS.some((pattern) => pattern.test(normalized));
}

export interface CommitMessageStats {
  sampled: number;
  distinctMessageRatio: number;
  genericMessageShare: number;
}

// Templated/bulk-generated histories tend to reuse a small pool of messages
// (or none at all) across many commits; organic day-to-day work produces a
// much wider spread of distinct, descriptive messages.
export function summarizeCommitMessages(messages: readonly string[]): CommitMessageStats {
  if (messages.length === 0) {
    return { sampled: 0, distinctMessageRatio: 1, genericMessageShare: 0 };
  }

  const distinct = new Set<string>();
  let genericCount = 0;

  for (const message of messages) {
    distinct.add(normalizeCommitMessage(message));
    if (isGenericCommitMessage(message)) genericCount++;
  }

  return {
    sampled: messages.length,
    distinctMessageRatio: distinct.size / messages.length,
    genericMessageShare: genericCount / messages.length
  };
}
