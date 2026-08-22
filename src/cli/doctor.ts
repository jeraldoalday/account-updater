import { config } from "../config";
import { auditConfig, formatFindings, hasBlockingFindings } from "../health/configAudit";
import { PROVIDER_HOSTS, PROVIDER_IDS } from "../providers/hosts";
import { isProviderSupported } from "../providers/registry";
import { version } from "../version";

/**
 * Which forges this build can evaluate, and whether each has a credential
 * configured.
 *
 * Worth printing next to the findings because the two facts are only
 * useful together: "GITLAB_TOKEN is not set" matters a great deal if
 * GitLab repos are evaluated here and not at all otherwise, and nothing
 * else in the output says which forges are even in play.
 */
function describeProviders(): string {
  const credentials: Partial<Record<string, string | undefined>> = {
    github: config.githubToken ?? (config.githubAppAuthConfig ? "app installation" : undefined),
    gitlab: config.gitlabToken
  };

  return PROVIDER_IDS.map((id) => {
    const name = PROVIDER_HOSTS[id].displayName;
    if (!isProviderSupported(id)) return `  ${name}: recognized, not implemented`;
    return `  ${name}: implemented, ${credentials[id] ? "credential configured" : "no credential (unauthenticated)"}`;
  }).join("\n");
}

/**
 * Reviews the configuration this environment would start the service with,
 * without starting it.
 *
 * Meant to be run against a deployment's real environment before it takes
 * traffic - in a release checklist, or as a container's pre-start step -
 * where the answer to "is this safe to ship" is otherwise a person
 * remembering which variables matter.
 *
 * Exits 1 when something critical is found, so a pipeline can gate on it;
 * warnings and notes are printed but don't fail the run, because several
 * of them are legitimate choices for a single-instance deployment.
 */
function main(): void {
  const findings = auditConfig(config);

  console.log(`account-updater ${version} - configuration review\n`);
  console.log("Providers:");
  console.log(`${describeProviders()}\n`);
  console.log(formatFindings(findings));

  const counts = {
    critical: findings.filter((f) => f.severity === "critical").length,
    warning: findings.filter((f) => f.severity === "warning").length,
    info: findings.filter((f) => f.severity === "info").length
  };
  console.log(
    `\n${counts.critical} critical, ${counts.warning} warning, ${counts.info} informational.`
  );

  if (hasBlockingFindings(findings)) {
    process.exitCode = 1;
  }
}

main();
