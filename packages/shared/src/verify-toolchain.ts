// bun run packages/shared/src/verify-toolchain.ts
//
// The pinned version lives in TWO places — TypeScript for a server Noddle
// provisions, bash for the machine the installer runs on. They can drift
// silently, and the symptom would be two servers building differently with
// nothing in the diff to explain it.
import { readFileSync } from "node:fs";
import { check, runVerify } from "@noddle/testing";
import { NIXPACKS_VERSION, nixpacksInstallCommand } from "#toolchain";

const SEMVER = /^\d+\.\d+\.\d+$/;
const UNPINNED_INSTALL =
  /curl[^\n]*nixpacks\.com\/install\.sh[^\n]*\|\s*\$SUDO bash\s*$/m;

const INSTALLER = new URL("../../../installer/install.sh", import.meta.url)
  .pathname;

await runVerify("toolchain pinning", () => {
  check(
    "the version is pinned, not a range or a tag",
    SEMVER.test(NIXPACKS_VERSION),
    `got "${NIXPACKS_VERSION}"`
  );

  const installer = readFileSync(INSTALLER, "utf8");
  check(
    "the installer pins the SAME version",
    installer.includes(`NIXPACKS_VERSION=${NIXPACKS_VERSION}`),
    `installer does not carry NIXPACKS_VERSION=${NIXPACKS_VERSION}`
  );

  check(
    "the installer never installs nixpacks unpinned",
    !UNPINNED_INSTALL.test(installer),
    "an unpinned install line is still present"
  );

  // `-E` is what carries NIXPACKS_VERSION across sudo. Without it the
  // variable is dropped and the install silently takes the latest — the
  // exact failure this pinning exists to prevent, wearing the disguise of
  // a correct-looking command.
  const command = nixpacksInstallCommand();
  check(
    "sudo preserves the environment, or the pin is a no-op",
    command.includes(`NIXPACKS_VERSION=${NIXPACKS_VERSION}`) &&
      command.includes("-E"),
    `got "${command}"`
  );
});
