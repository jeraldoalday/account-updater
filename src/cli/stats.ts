import { execFileSync } from "node:child_process";
import { scanSource } from "../analysis/sourceScan";
import { buildLocalHistorySummary } from "./localHistory";
import { checkLanguage } from "../eligibility/checks/language";
import { checkSize } from "../eligibility/checks/size";
import { checkHistory } from "../eligibility/checks/history";
import { checkActiveDevelopment } from "../eligibility/checks/activity";
import type { SampledCommit } from "../analysis/commitSample";
import type { PushEventSummary } from "../types";

const RECORD_SEP = "\x1f"; // unit separator - won't appear in author/subject text

function getLocalCommits(): SampledCommit[] {
  const out = execFileSync("git", ["log", `--pretty=format:%aI${RECORD_SEP}%ae${RECORD_SEP}%s`], {
    encoding: "utf8"
  });
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [date, authorKey, message] = line.split(RECORD_SEP);
      return { date: date || null, authorKey: authorKey || null, message: message ?? "" };
    });
}

function statusIcon(passed: boolean): string {
  return passed ? "PASS" : "FAIL";
}

// Local git history has no GitHub push-event data, so that signal is
// reported as unavailable (neutral) rather than penalized.
const NO_PUSH_EVENTS: PushEventSummary = {
  available: false,
  distinctPushDays: 0,
  maxSinglePushCommitShare: 0
};

async function main() {
  const scan = await scanSource(process.cwd());
  const history = buildLocalHistorySummary(getLocalCommits());

  // Runs the same check functions the live service evaluates against, so
  // this self-check can't silently drift from real eligibility behavior.
  const language = checkLanguage(scan);
  const size = checkSize(scan);
  const historyCheck = checkHistory(history);
  const activity = checkActiveDevelopment(history, NO_PUSH_EVENTS);

  console.log("account-updater self-check (local, uncommitted work not tracked by git)\n");

  console.log(`[${statusIcon(language.passed)}] language     primary=${language.primaryLanguage ?? "none"}`);
  console.log(
    `[${statusIcon(size.passed)}] size         lines=${size.totalLines}  files=${size.totalFiles}`
  );
  console.log(
    `[${statusIcon(historyCheck.passed)}] history      commits=${historyCheck.commitCount}  spanDays=${historyCheck.historyDays}`
  );
  console.log(
    `[${statusIcon(activity.passed)}] activity     score=${activity.score.toFixed(2)}  ` +
      `distinctDays=${activity.distinctCommitDays}  maxDayShare=${(activity.maxSingleDayCommitShare * 100).toFixed(0)}%  ` +
      `authors=${activity.authorStats.distinctAuthors}  genericMsgs=${(activity.messageStats.genericMessageShare * 100).toFixed(0)}%`
  );

  for (const check of [language, size, historyCheck, activity]) {
    for (const reason of check.reasons) console.log(`    - ${reason}`);
  }

  console.log(`\nby language:`);
  for (const s of scan.byLanguage) {
    console.log(`  ${s.language}: ${s.lines} lines, ${s.files} files`);
  }

  const eligible = language.passed && size.passed && historyCheck.passed && activity.passed;
  console.log(`\noverall: ${eligible ? "ELIGIBLE" : "NOT YET ELIGIBLE"}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
