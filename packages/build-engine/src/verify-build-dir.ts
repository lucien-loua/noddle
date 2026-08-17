// tier: pure
// bun run packages/build-engine/src/verify-build-dir.ts
//
// Pure: no VM. `resolveBuildDir` turns a user-supplied string into a `cd`
// target on the client's server, so what matters here is the REFUSALS.
import { check, expectThrows, runVerify } from "@noddle/testing";

import {
  BuildError,
  FORCED_DEPLOY_PACKAGES,
  looksOutOfMemory,
  resolveBuildDir,
} from "#index";

const CLONE = "/var/lib/noddle/builds/abc";
const WHITESPACE = /\s+/;

await runVerify("build directory resolution", () => {
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

  // Not a traversal, but git would read it as a flag — same defense as
  // fetchSource applies, because this string also reaches a command line.
  expectThrows(
    "a leading dash is refused",
    () => resolveBuildDir(CLONE, "-rf"),
    (e) => e instanceof BuildError
  );

  // The leading `...` means "extend railpack's generated package list".
  // Without it the list is REPLACED, and the image silently loses whatever
  // the provider put there — a build that still succeeds and an image that
  // is quietly wrong, which is the worst shape a failure can take.
  check(
    "the forced package list EXTENDS rather than replaces",
    FORCED_DEPLOY_PACKAGES.trimStart().startsWith("...")
  );

  // Measured inside a built image, under the same non-login `sh -c` a
  // HEALTHCHECK runs in: railpack's Debian base has NO curl and NO wget.
  // The deploy healthcheck is a curl probe, so Noddle has to put it there
  // or every task fails to converge and it reads as a routing bug.
  check(
    "curl is forced into every image Noddle builds from source",
    FORCED_DEPLOY_PACKAGES.split(WHITESPACE).includes("curl")
  );

  // Measured on a 2 GB VM: Next.js compiled, then TypeScript was killed and
  // buildkit reported only `code 102` under a wall of layer output. Each of
  // these is how one of the three layers phrases the same cause.
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
});
