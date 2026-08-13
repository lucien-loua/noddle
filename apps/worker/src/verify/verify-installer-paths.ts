// bun run apps/worker/src/verify/verify-installer-paths.ts
//
// The installer invokes worker scripts by PATH, inside a shell string. Nothing
// else ties those paths to the file tree: neither the typechecker nor Biome
// looks inside a shell command. So a refactor can move a script and leave the
// installer pointing at nothing, and the repository stays green.
//
// That is not hypothetical — `adopt-host.ts` moved to `target/` and the
// installer kept calling `src/adopt-host.ts`. With `set -euo pipefail`, every
// fresh install aborted at the adoption step, leaving no server #1 at all.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { check, runVerify } from "@noddle/testing";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const INSTALL_SH = join(REPO_ROOT, "installer", "install.sh");

/** `apps/worker/Dockerfile` ends on `WORKDIR /noddle/apps/worker`, and the
 *  image root mirrors the repository. A relative path therefore resolves from
 *  the worker package, an absolute one from the repository root. This mapping
 *  IS the coupling being verified here. */
const IMAGE_ROOT = "/noddle/";
const WORKDIR = join(REPO_ROOT, "apps", "worker");

const INVOCATION = /\b(?:node|bun)\s+(?:run\s+)?(\S+\.ts)\b/g;

function resolveInvocation(invoked: string): string {
  return invoked.startsWith(IMAGE_ROOT)
    ? join(REPO_ROOT, invoked.slice(IMAGE_ROOT.length))
    : join(WORKDIR, invoked);
}

await runVerify("installer script paths", () => {
  const script = readFileSync(INSTALL_SH, "utf8");
  const invoked = [...script.matchAll(INVOCATION)].map((match) => match[1]);

  // Guards the guard. Without a floor, the day the pattern stops matching this
  // suite checks nothing and still reports success — the exact failure shape
  // it exists to catch.
  check(
    `install.sh invokes at least two scripts (found ${invoked.length})`,
    invoked.length >= 2
  );

  for (const path of invoked) {
    check(
      `${path} exists`,
      path !== undefined && existsSync(resolveInvocation(path)),
      "referenced by installer/install.sh"
    );
  }
});
