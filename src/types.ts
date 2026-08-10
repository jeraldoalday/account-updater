import type { AllowedLanguage } from "./eligibility/thresholds";

export interface RepoRef {
  owner: string;
  repo: string;
}

export interface LanguageStats {
  language: string;
  lines: number;
  files: number;
}

export interface SourceScanResult {
  byLanguage: LanguageStats[];
  totalLines: number;
  totalFiles: number;
  primaryLanguage: string | null;
}

export interface CommitHistorySummary {
  commitCount: number;
  firstCommitDate: string | null;
  lastCommitDate: string | null;
  historyDays: number;
  commitsByDay: Record<string, number>;
  distinctCommitDays: number;
  maxSingleDayCommitShare: number;
  truncated: boolean;
}

export interface PushEventSummary {
  available: boolean;
  distinctPushDays: number;
  maxSinglePushCommitShare: number;
}

export interface CheckResult {
  passed: boolean;
  reasons: string[];
}

export interface EligibilityResult {
  eligible: boolean;
  repo: RepoRef;
  checks: {
    language: CheckResult & { primaryLanguage: string | null };
    size: CheckResult & { totalLines: number; totalFiles: number };
    history: CheckResult & {
      commitCount: number;
      historyDays: number;
      firstCommitDate: string | null;
      lastCommitDate: string | null;
    };
    activeDevelopment: CheckResult & {
      distinctCommitDays: number;
      maxSingleDayCommitShare: number;
      pushEvents: PushEventSummary;
    };
  };
  reasons: string[];
}

export type { AllowedLanguage };
