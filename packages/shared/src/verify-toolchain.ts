// tier: pure
import { readFileSync } from "node:fs";

import { check, runVerify } from "@noddle/testing";

import {
  BUILDKIT_IMAGE,
  BUN_VERSION,
  RAILPACK_VERSION,
  railpackInstallCommand,
} from "#toolchain";

const SEMVER = /^\d+\.\d+\.\d+$/;
const UNPINNED_INSTALL =
  /curl[^\n]*railpack\.com\/install\.sh[^\n]*\|\s*\$SUDO sh\s*$/m;
const PINNED_IMAGE = /^moby\/buildkit:v\d+\.\d+\.\d+$/;

const INSTALLER = new URL("../../../installer/install.sh", import.meta.url)
  .pathname;
const DOCKERFILES = ["dashboard", "worker"].map(
  (app) => new URL(`../../../apps/${app}/Dockerfile`, import.meta.url).pathname
);
const FLOATING_BUN = /oven\/bun:\d+\s*$|bun\.sh\/install[^\n]*\|\s*bash\s*$/m;

await runVerify("toolchain pinning", () => {
  check(
    "the version is pinned, not a range or a tag",
    SEMVER.test(RAILPACK_VERSION),
    `got "${RAILPACK_VERSION}"`
  );

  const installer = readFileSync(INSTALLER, "utf-8");
  check(
    "the installer pins the SAME version",
    installer.includes(`RAILPACK_VERSION=${RAILPACK_VERSION}`),
    `installer does not carry RAILPACK_VERSION=${RAILPACK_VERSION}`
  );

  check(
    "the installer never installs railpack unpinned",
    !UNPINNED_INSTALL.test(installer),
    "an unpinned install line is still present"
  );

  const command = railpackInstallCommand();
  check(
    "sudo preserves the environment, or the pin is a no-op",
    command.includes(`RAILPACK_VERSION=${RAILPACK_VERSION}`) &&
      command.includes("-E"),
    `got "${command}"`
  );

  check(
    "the BuildKit daemon image is pinned to an exact tag",
    PINNED_IMAGE.test(BUILDKIT_IMAGE),
    `got "${BUILDKIT_IMAGE}"`
  );

  check(
    "the installer pins the SAME BuildKit image",
    installer.includes(BUILDKIT_IMAGE),
    `installer does not carry ${BUILDKIT_IMAGE}`
  );

  check(
    "the bun version is pinned, not a range or a tag",
    SEMVER.test(BUN_VERSION),
    `got "${BUN_VERSION}"`
  );

  for (const path of DOCKERFILES) {
    const dockerfile = readFileSync(path, "utf-8");
    const app = path.split("/").at(-2);
    check(
      `the ${app} image pins the SAME bun`,
      dockerfile.includes(`ARG BUN_VERSION=${BUN_VERSION}`),
      `${app} does not carry ARG BUN_VERSION=${BUN_VERSION}`
    );
    check(
      `the ${app} image never takes whatever bun is latest`,
      !FLOATING_BUN.test(dockerfile),
      `${app} still has a floating bun line`
    );
  }
});
