// tier: pure
// bun run packages/shared/src/verify-toolchain.ts
//
// The pinned version lives in TWO places — TypeScript for a server Noddle
// provisions, bash for the machine the installer runs on. They can drift
// silently, and the symptom would be two servers building differently with
// nothing in the diff to explain it.
import { readFileSync } from "node:fs";

import { check, runVerify } from "@noddle/testing";

import {
  BUILDKIT_IMAGE,
  RAILPACK_VERSION,
  railpackInstallCommand,
} from "#toolchain";

const SEMVER = /^\d+\.\d+\.\d+$/;
const UNPINNED_INSTALL =
  /curl[^\n]*railpack\.com\/install\.sh[^\n]*\|\s*\$SUDO sh\s*$/m;
// A tag, never `latest`: the point of running buildkitd ourselves is that its
// version stops moving underneath existing servers.
const PINNED_IMAGE = /^moby\/buildkit:v\d+\.\d+\.\d+$/;

const INSTALLER = new URL("../../../installer/install.sh", import.meta.url)
  .pathname;

await runVerify("toolchain pinning", () => {
  check(
    "the version is pinned, not a range or a tag",
    SEMVER.test(RAILPACK_VERSION),
    `got "${RAILPACK_VERSION}"`
  );

  const installer = readFileSync(INSTALLER, "utf8");
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

  // `-E` is what carries RAILPACK_VERSION across sudo. Without it the
  // variable is dropped and the install silently takes the latest — the
  // exact failure this pinning exists to prevent, wearing the disguise of
  // a correct-looking command.
  const command = railpackInstallCommand();
  check(
    "sudo preserves the environment, or the pin is a no-op",
    command.includes(`RAILPACK_VERSION=${RAILPACK_VERSION}`) &&
      command.includes("-E"),
    `got "${command}"`
  );

  // Noddle starts buildkitd itself, so it owns this version too. `latest`
  // here would move the build cap's host out from under existing servers.
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
});
