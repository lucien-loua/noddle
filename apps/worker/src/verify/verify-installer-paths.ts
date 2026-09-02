// tier: pure
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { check, runVerify } from "@noddle/testing";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const INSTALL_SH = join(REPO_ROOT, "installer", "install.sh");

const IMAGE_ROOT = "/noddle/";
const WORKDIR = join(REPO_ROOT, "apps", "worker");

const INVOCATION = /\b(?:node|bun)\s+(?:run\s+)?(\S+\.ts)\b/g;

function resolveInvocation(invoked: string): string {
  return invoked.startsWith(IMAGE_ROOT)
    ? join(REPO_ROOT, invoked.slice(IMAGE_ROOT.length))
    : join(WORKDIR, invoked);
}

await runVerify("installer script paths", () => {
  const script = readFileSync(INSTALL_SH, "utf-8");
  const invoked = [...script.matchAll(INVOCATION)].map((match) => match[1]);

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
