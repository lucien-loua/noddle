// bun run packages/build-engine/src/verify-build-dir.ts
//
// Pure: no VM. `resolveBuildDir` turns a user-supplied string into a `cd`
// target on the client's server, so what matters here is the REFUSALS.
import { check, expectThrows, runVerify } from "@noddle/testing";
import { BuildError, nixpacksNodeFlag, resolveBuildDir } from "#index";

const CLONE = "/var/lib/noddle/builds/abc";

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

  // Measured on 1.41.0: the process environment is IGNORED, and
  // `--env NODE_VERSION` is the wrong name. Only this shape moves the plan
  // off the dead default, and `--env` leaves the nix overlay intact where
  // `--apt` and `--pkgs` wipe it.
  check(
    "the Node fallback is passed as --env, the only form nixpacks reads",
    nixpacksNodeFlag(false).startsWith(" --env NIXPACKS_NODE_VERSION=") &&
      nixpacksNodeFlag(true) === ""
  );
});
