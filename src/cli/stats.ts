import { execFileSync } from "node:child_process";
import { scanSource } from "../analysis/sourceScan";
import { ALLOWED_LANGUAGES, THRESHOLDS } from "../eligibility/thresholds";

function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

function getLocalCommitDates(): string[] {
  const out = execFileSync("git", ["log", "--pretty=format:%aI"], { encoding: "utf8" });
  return out.split("\n").filter(Boolean);
}

function statusIcon(passed: boolean): string {
  return passed ? "PASS" : "FAIL";
}

async function main() {
  const scan = await scanSource(process.cwd());
  const dates = getLocalCommitDates();

  const commitCount = dates.length;
  const sorted = [...dates].sort();
  const firstCommitDate = sorted[0] ?? null;
  const lastCommitDate = sorted[sorted.length - 1] ?? null;
  const historyDays =
    firstCommitDate && lastCommitDate
      ? Math.round(
          (new Date(lastCommitDate).getTime() - new Date(firstCommitDate).getTime()) /
            (1000 * 60 * 60 * 24)
        )
      : 0;

  const commitsByDay: Record<string, number> = {};
  for (const d of dates) commitsByDay[dayKey(d)] = (commitsByDay[dayKey(d)] ?? 0) + 1;
  const distinctCommitDays = Object.keys(commitsByDay).length;
  const maxSingleDayCommitShare =
    commitCount > 0 ? Math.max(...Object.values(commitsByDay)) / commitCount : 0;

  const languagePassed =
    !!scan.primaryLanguage &&
    (ALLOWED_LANGUAGES as readonly string[]).includes(scan.primaryLanguage);
  const sizePassed =
    scan.totalLines >= THRESHOLDS.minLines && scan.totalFiles >= THRESHOLDS.minFiles;
  const historyPassed =
    commitCount >= THRESHOLDS.minCommits && historyDays >= THRESHOLDS.minHistoryDays;
  const activityPassed =
    distinctCommitDays >= THRESHOLDS.minDistinctCommitDays &&
    maxSingleDayCommitShare <= THRESHOLDS.maxSingleDayCommitShare;

  console.log("account-updater self-check (local, uncommitted work not tracked by git)\n");

  console.log(
    `[${statusIcon(languagePassed)}] language     primary=${scan.primaryLanguage ?? "none"}`
  );
  console.log(
    `[${statusIcon(sizePassed)}] size         lines=${scan.totalLines}/${THRESHOLDS.minLines}  files=${scan.totalFiles}/${THRESHOLDS.minFiles}`
  );
  console.log(
    `[${statusIcon(historyPassed)}] history      commits=${commitCount}/${THRESHOLDS.minCommits}  spanDays=${historyDays}/${THRESHOLDS.minHistoryDays}`
  );
  console.log(
    `[${statusIcon(activityPassed)}] activity     distinctDays=${distinctCommitDays}/${THRESHOLDS.minDistinctCommitDays}  maxDayShare=${(maxSingleDayCommitShare * 100).toFixed(0)}%/${THRESHOLDS.maxSingleDayCommitShare * 100}%`
  );

  console.log(`\nby language:`);
  for (const s of scan.byLanguage) {
    console.log(`  ${s.language}: ${s.lines} lines, ${s.files} files`);
  }

  console.log(
    `\noverall: ${languagePassed && sizePassed && historyPassed && activityPassed ? "ELIGIBLE" : "NOT YET ELIGIBLE"}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
