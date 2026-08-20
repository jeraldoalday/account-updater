import { DEFAULT_SMOKE_REPOS, formatSmokeReport, runSmokeTest } from "./smokeRunner";

/**
 * Drives a *running* instance end to end:
 *
 *   npm run smoke                          # localhost:3000
 *   npm run smoke -- --url https://...     # a deployed instance
 *   npm run smoke -- rust-lang/rust        # specific repos
 *
 * The unit and integration suites run against fakes on purpose, so they
 * pass whether or not the deployed service can clone a repo, reach GitHub,
 * or write its database. This is the check that covers that gap, which
 * makes it the one worth running immediately after a deploy.
 *
 * `SMOKE_URL` and `SMOKE_API_KEY` are read from the environment when the
 * flags aren't given, so it can run in a pipeline without assembling a
 * command line.
 */
function parseArgs(argv: string[]): { baseUrl: string; apiKey?: string; repos: string[] } {
  const repos: string[] = [];
  let baseUrl = process.env.SMOKE_URL ?? "http://localhost:3000";
  let apiKey = process.env.SMOKE_API_KEY ?? process.env.API_KEY;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--url") baseUrl = argv[++i];
    else if (arg === "--api-key") apiKey = argv[++i];
    else repos.push(arg);
  }

  return { baseUrl, apiKey, repos: repos.length > 0 ? repos : DEFAULT_SMOKE_REPOS };
}

async function main(): Promise<void> {
  const { baseUrl, apiKey, repos } = parseArgs(process.argv.slice(2));

  const report = await runSmokeTest({ baseUrl, apiKey, repos, fetch: globalThis.fetch });
  console.log(formatSmokeReport(report));

  if (!report.passed) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  // A connection refused here means the instance isn't up at all, which is
  // a smoke-test failure like any other rather than a crash.
  console.error(`Smoke test could not run: ${(err as Error).message}`);
  process.exitCode = 1;
});
