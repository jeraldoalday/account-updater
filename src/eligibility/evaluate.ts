import { GitHubClient } from "../github/client";
import { withShallowClone } from "../clone/tempClone";
import { scanSource } from "../analysis/sourceScan";
import { checkLanguage } from "./checks/language";
import { checkSize } from "./checks/size";
import { checkHistory } from "./checks/history";
import { checkActiveDevelopment } from "./checks/activity";
import type { EligibilityResult, RepoRef } from "../types";

export async function evaluateEligibility(
  ref: RepoRef,
  token: string | undefined
): Promise<EligibilityResult> {
  const client = new GitHubClient(token);

  const [scan, history, pushEvents] = await Promise.all([
    withShallowClone(ref, token, (dir) => scanSource(dir)),
    client.getCommitHistorySummary(ref),
    client.getPushEventSummary(ref)
  ]);

  const language = checkLanguage(scan);
  const size = checkSize(scan);
  const historyCheck = checkHistory(history);
  const activeDevelopment = checkActiveDevelopment(history, pushEvents);

  const eligible = language.passed && size.passed && historyCheck.passed && activeDevelopment.passed;

  return {
    eligible,
    repo: ref,
    checks: {
      language,
      size,
      history: historyCheck,
      activeDevelopment
    },
    reasons: [
      ...language.reasons,
      ...size.reasons,
      ...historyCheck.reasons,
      ...activeDevelopment.reasons
    ]
  };
}
