// tier: pure
// bun run apps/worker/src/verify/verify-dockerfile-workspaces.ts
//
// Both images copy every workspace manifest before `bun install
// --frozen-lockfile`, which compares the lockfile against the WHOLE workspace:
// miss one and resolution differs, so the install fails on "lockfile had
// changes". Both Dockerfiles say so in a comment, and nothing enforced it.
//
// Nine packages had drifted out of both lists, so neither image built and no
// fresh install could complete. Same shape as the installer path bug: a
// hand-maintained list that no tool compares to the file tree.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { check, runVerify } from "@noddle/testing";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const DOCKERFILES = ["apps/web/Dockerfile", "apps/worker/Dockerfile"];

function workspaceMembers(): string[] {
  const dirs = (group: string) =>
    readdirSync(join(REPO_ROOT, group), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${group}/${entry.name}`)
      .filter((member) => existsSync(join(REPO_ROOT, member, "package.json")));

  return [...dirs("apps"), ...dirs("packages")].sort();
}

await runVerify("Dockerfile workspace manifests", () => {
  const members = workspaceMembers();

  // A floor, so a members list gone empty cannot pass by checking nothing.
  check(`workspace has members (${members.length})`, members.length >= 10);

  for (const dockerfile of DOCKERFILES) {
    const content = readFileSync(join(REPO_ROOT, dockerfile), "utf8");

    for (const member of members) {
      check(
        `${dockerfile} copies ${member}/package.json`,
        content.includes(`COPY ${member}/package.json ${member}/`)
      );
    }
  }
});
