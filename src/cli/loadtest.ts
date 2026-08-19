import {
  LoadTestArgumentError,
  formatReport,
  parseLoadTestArgs,
  runLoadTest
} from "./loadTestRunner";

const USAGE = `Usage: npm run loadtest -- --repo owner/name [options]

  --repo         repo reference to check (required)
  --url          base URL of a running service (default http://localhost:3000)
  --requests     total requests to send (default 50)
  --concurrency  requests in flight at once (default 10)
  --api-key      value for the x-api-key header, if the service requires one

Sends the same repo repeatedly on purpose: the useful signals are how many
requests the rate limiter rejects, and how few evaluations the service
actually performs compared to the number of requests made.`;

async function main() {
  let options;
  try {
    options = parseLoadTestArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof LoadTestArgumentError) {
      console.error(`${err.message}\n\n${USAGE}`);
      process.exit(2);
    }
    throw err;
  }

  console.log(`load testing ${options.url} with repo "${options.repo}"\n`);
  const report = await runLoadTest(options);
  console.log(formatReport(report));

  // A load test that never reached the service is a failed run, not a
  // result worth reporting as success to CI or a script.
  if (report.failed === report.requests) {
    console.error("\nEvery request failed - is the service running?");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
