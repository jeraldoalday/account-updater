import { THRESHOLDS } from "../thresholds";
import type { CheckResult, SourceScanResult } from "../../types";

export function checkSize(
  scan: SourceScanResult
): CheckResult & { totalLines: number; totalFiles: number } {
  const reasons: string[] = [];

  if (scan.totalLines < THRESHOLDS.minLines) {
    reasons.push(
      `Only ${scan.totalLines} lines of first-party source found (need at least ${THRESHOLDS.minLines}).`
    );
  }
  if (scan.totalFiles < THRESHOLDS.minFiles) {
    reasons.push(
      `Only ${scan.totalFiles} first-party source files found (need at least ${THRESHOLDS.minFiles}).`
    );
  }

  return {
    passed: reasons.length === 0,
    totalLines: scan.totalLines,
    totalFiles: scan.totalFiles,
    reasons
  };
}
