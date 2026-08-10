import { ALLOWED_LANGUAGES } from "../thresholds";
import type { CheckResult, SourceScanResult } from "../../types";

export function checkLanguage(
  scan: SourceScanResult
): CheckResult & { primaryLanguage: string | null } {
  const primaryLanguage = scan.primaryLanguage;
  const reasons: string[] = [];

  if (!primaryLanguage) {
    reasons.push("No first-party source files were found in an eligible language.");
    return { passed: false, primaryLanguage: null, reasons };
  }

  const passed = (ALLOWED_LANGUAGES as readonly string[]).includes(primaryLanguage);
  if (!passed) {
    reasons.push(
      `Primary language "${primaryLanguage}" is not one of the eligible languages (${ALLOWED_LANGUAGES.join(", ")}).`
    );
  }

  return { passed, primaryLanguage, reasons };
}
