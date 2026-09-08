// tier: pure
import { check, expectThrows, runVerify, suite } from "@noddle/testing";

import { COMMANDS, parseArgs, UsageError, waitTimeoutMs } from "#args";
import {
  CliError,
  describeFailure,
  deploymentExitCode,
  FAILED_STATUSES,
  resolveConfig,
} from "#client";

const DEPLOYMENT_STATUSES = [
  "queued",
  "building",
  "deploying",
  "succeeded",
  "failed",
  "rolled_back",
  "reverted_by_watch",
];

await runVerify("noddle cli", async () => {
  await suite("the command line is read the way a pipeline writes it", () => {
    const both = parseArgs(["deploy", "svc-1", "--wait", "--timeout", "60"]);
    check("the command is taken", both.command === "deploy");
    check("its argument is kept", both.positional[0] === "svc-1");
    check("a boolean flag is set", both.flags.wait === true);
    check("a value flag takes the next word", both.flags.timeout === "60");

    const inline = parseArgs(["deploy", "svc", "--timeout=90", "--json"]);
    check("--flag=value works too", inline.flags.timeout === "90");
    check("and still sets the others", inline.flags.json === true);

    const dashed = parseArgs(["deploy", "--", "--not-a-flag"]);
    check("-- ends the options", dashed.positional[0] === "--not-a-flag");

    check("-h is help", parseArgs(["-h"]).flags.help === true);
    check("no arguments is no command", parseArgs([]).command === null);
  });

  await suite("a mistake is refused rather than guessed at", () => {
    expectThrows("an unknown command", () => parseArgs(["deployy"]));
    expectThrows("an unknown option", () => parseArgs(["whoami", "--loud"]));
    expectThrows("a short unknown option", () => parseArgs(["whoami", "-x"]));
    expectThrows("a value flag with nothing after it", () =>
      parseArgs(["whoami", "--url"])
    );
    expectThrows("a boolean flag given a value", () =>
      parseArgs(["whoami", "--json=yes"])
    );
    expectThrows("a timeout that is not a number", () => waitTimeoutMs("soon"));
    expectThrows("a timeout of zero", () => waitTimeoutMs("0"));

    check(
      "every refusal is a UsageError, so it exits 2 and not 1",
      (() => {
        try {
          parseArgs(["nope"]);
          return false;
        } catch (error) {
          return error instanceof UsageError;
        }
      })()
    );
  });

  await suite("configuration comes from the flag, then the environment", () => {
    const fromEnv = resolveConfig(
      {},
      { NODDLE_TOKEN: "t", NODDLE_URL: "https://n.example.com" }
    );
    check("the environment is read", fromEnv.url === "https://n.example.com");

    const fromFlag = resolveConfig(
      { token: "flag-token", url: "https://other.example.com" },
      { NODDLE_TOKEN: "env-token", NODDLE_URL: "https://n.example.com" }
    );
    check("a flag wins over the environment", fromFlag.token === "flag-token");

    const trailing = resolveConfig(
      {},
      { NODDLE_TOKEN: "t", NODDLE_URL: "https://n.example.com///" }
    );
    check(
      "a trailing slash cannot produce a double slash in the path",
      trailing.url === "https://n.example.com"
    );

    expectThrows("a missing url", () =>
      resolveConfig({}, { NODDLE_TOKEN: "t" })
    );
    expectThrows("a missing token", () =>
      resolveConfig({}, { NODDLE_URL: "https://n.example.com" })
    );
    check(
      "and both say what to do about it",
      (() => {
        try {
          resolveConfig({}, {});
          return false;
        } catch (error) {
          return (
            error instanceof CliError && error.message.includes("NODDLE_URL")
          );
        }
      })()
    );
  });

  await suite("a failed deployment fails the command", () => {
    for (const status of DEPLOYMENT_STATUSES) {
      const failed = FAILED_STATUSES.has(status);
      check(
        `${status} exits ${failed ? 1 : 0}`,
        deploymentExitCode(status) === (failed ? 1 : 0)
      );
    }
    check(
      "rolled_back counts as a failure, because the deploy did not land",
      deploymentExitCode("rolled_back") === 1
    );
  });

  await suite("an HTTP failure is explained, not echoed", () => {
    check("401 blames the token", describeFailure(401, {}).includes("refused"));
    check(
      "403 passes the server's reason through",
      describeFailure(403, { message: "This token does not carry x:y." }) ===
        "This token does not carry x:y."
    );
    check(
      "an unknown status still says something",
      describeFailure(503, {}).includes("503")
    );
  });

  await suite("--version answers instead of being accepted and ignored", () => {
    check("it parses", parseArgs(["--version"]).flags.version === true);
    check(
      "and it needs no command, so it cannot fall into the usage path",
      parseArgs(["--version"]).command === null
    );
  });

  await suite("every command in the help is a command", () => {
    for (const command of COMMANDS) {
      check(`${command} parses`, parseArgs([command]).command === command);
    }
  });
});
