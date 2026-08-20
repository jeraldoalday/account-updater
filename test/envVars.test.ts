import { describe, expect, it } from "vitest";
import {
  CLI_ONLY_ENV_VARS,
  envVarsUsedInSource,
  parseEnvExample,
  readEnvExample,
  readEnvExampleValues
} from "./helpers/envVars";

describe("parseEnvExample", () => {
  it("reads the keys, ignoring comments and blank lines", () => {
    expect(parseEnvExample("# a comment\nPORT=3000\n\nAPI_KEY=\n")).toEqual(["PORT", "API_KEY"]);
  });

  it("ignores a commented-out setting, which isn't documentation of one", () => {
    expect(parseEnvExample("# PORT=3000\n")).toEqual([]);
  });
});

/**
 * Configuration is the part of a service that is easiest to add and
 * easiest to forget to write down: the code works on the machine where the
 * variable was invented, and the first person to deploy it without that
 * variable finds out by having it not work. These compare both lists in
 * both directions, so a new setting has to be documented and a removed one
 * has to stop being.
 */
describe(".env.example", () => {
  const documented = readEnvExample();
  const used = envVarsUsedInSource();

  it("documents every variable the service reads", () => {
    const undocumented = used.filter(
      (name) => !documented.includes(name) && !CLI_ONLY_ENV_VARS.includes(name)
    );
    expect(undocumented).toEqual([]);
  });

  it("documents nothing the service no longer reads", () => {
    const stale = documented.filter((name) => !used.includes(name));
    expect(stale).toEqual([]);
  });

  it("finds a meaningful number of variables, so a broken scan can't pass silently", () => {
    expect(used.length).toBeGreaterThan(10);
  });

  it("leaves credential settings blank, so copying the file can't ship a real one", () => {
    // .env.example is meant to be copied to .env. A secret pre-filled here
    // is a secret in the repo, and then a secret in every deployment made
    // by someone who copied it without reading it.
    const filledInCredentials = Object.entries(readEnvExampleValues())
      .filter(([name]) => /KEY|TOKEN|SECRET|PASSWORD/.test(name))
      .filter(([, value]) => value !== "");

    expect(filledInCredentials).toEqual([]);
  });
});

describe("envVarsUsedInSource", () => {
  it("finds variables read through the config helper", () => {
    expect(envVarsUsedInSource()).toContain("GITHUB_TOKEN");
  });

  it("finds variables read straight off process.env, outside config.ts", () => {
    // ELIGIBLE_LANGUAGES is read in thresholds.ts, not through the schema.
    expect(envVarsUsedInSource()).toContain("ELIGIBLE_LANGUAGES");
  });
});
