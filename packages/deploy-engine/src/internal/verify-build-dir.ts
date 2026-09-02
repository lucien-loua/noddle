// tier: pure
import { check, expectThrows, runVerify, suite } from "@noddle/testing";

import {
  BuildError,
  cloneAuthHint,
  FORCED_DEPLOY_PACKAGES,
  gitEnvPrefix,
  looksOutOfMemory,
  looksUnauthenticated,
  resolveBuildDir,
} from "./build.ts";

const CLONE = "/var/lib/noddle/builds/abc";
const WHITESPACE = /\s+/;

function verifyBuildDirectory(): void {
  check(
    "no build path builds the clone root",
    resolveBuildDir(CLONE, null) === CLONE &&
      resolveBuildDir(CLONE, undefined) === CLONE &&
      resolveBuildDir(CLONE, "") === CLONE &&
      resolveBuildDir(CLONE, "   ") === CLONE
  );

  check(
    "a subdirectory is appended",
    resolveBuildDir(CLONE, "apps/web") === `${CLONE}/apps/web`
  );

  check(
    "surrounding slashes are tolerated, not treated as absolute",
    resolveBuildDir(CLONE, "/apps/web/") === `${CLONE}/apps/web`
  );

  for (const outside of ["..", "../etc", "apps/../../etc", "apps//web"]) {
    expectThrows(
      `"${outside}" is refused`,
      () => resolveBuildDir(CLONE, outside),
      (e) => e instanceof BuildError
    );
  }

  expectThrows(
    "a leading dash is refused",
    () => resolveBuildDir(CLONE, "-rf"),
    (e) => e instanceof BuildError
  );

  check(
    "the forced package list EXTENDS rather than replaces",
    FORCED_DEPLOY_PACKAGES.trimStart().startsWith("...")
  );

  check(
    "curl is forced into every image Noddle builds from source",
    FORCED_DEPLOY_PACKAGES.split(WHITESPACE).includes("curl")
  );

  check(
    "every shape of an out-of-memory build is recognised",
    [
      "ERROR: failed to solve: ResourceExhausted: process ... cannot allocate memory",
      'error: script "build" was terminated by signal SIGKILL (Forced quit)',
      "Killed",
      "fatal error: out of memory",
    ].every(looksOutOfMemory)
  );

  check(
    "an ordinary build failure is NOT reported as memory",
    !looksOutOfMemory(
      "error TS2304: Cannot find name 'foo'\nbuild failed with 1 error"
    )
  );
}

function verifyCloneAuth(): void {
  check(
    "git never waits on a prompt no one can answer",
    gitEnvPrefix(null).includes("GIT_TERMINAL_PROMPT=0") &&
      gitEnvPrefix("ssh -i /var/lib/noddle/keys/x/id").includes(
        "GIT_TERMINAL_PROMPT=0"
      )
  );

  check(
    "a deploy key still reaches git",
    gitEnvPrefix("ssh -i /var/lib/noddle/keys/x/id").includes(
      "GIT_SSH_COMMAND="
    )
  );

  check(
    "every shape of a refused clone is recognised",
    [
      "fatal: could not read Username for 'https://github.com': No such device or address",
      "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
      "remote: Repository not found.",
      "fatal: Authentication failed for 'https://github.com/org/app.git/'",
      "git@github.com: Permission denied (publickey).",
      "Please make sure you have the correct access rights",
    ].every(looksUnauthenticated)
  );

  check(
    "an ordinary clone failure is NOT reported as authentication",
    !looksUnauthenticated(
      "fatal: Remote branch nope not found in upstream origin"
    )
  );

  check(
    "an anonymous https clone names both ways out",
    (() => {
      const hint = cloneAuthHint({
        deployKey: null,
        repoUrl: "https://github.com/org/app.git",
      });
      return (
        hint.includes("git provider") &&
        hint.includes("SSH") &&
        hint.includes("never over https")
      );
    })()
  );

  check(
    "a token that was sent and refused is not blamed on the configuration",
    cloneAuthHint({
      deployKey: null,
      repoUrl: "https://x-access-token:ghs_token@github.com/org/app.git",
    }).includes("refused")
  );

  check(
    "an SSH URL with a key points at the repository side",
    cloneAuthHint({
      deployKey: "-----BEGIN OPENSSH PRIVATE KEY-----",
      repoUrl: "git@github.com:org/app.git",
    }).includes("public half")
  );

  check(
    "an SSH URL with no key says so",
    cloneAuthHint({
      deployKey: null,
      repoUrl: "git@github.com:org/app.git",
    }).includes("No deploy key")
  );
}

await runVerify("build engine", async () => {
  await suite("build directory", verifyBuildDirectory);
  await suite("clone authentication", verifyCloneAuth);
});
