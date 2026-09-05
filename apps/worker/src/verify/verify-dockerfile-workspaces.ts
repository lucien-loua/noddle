// tier: pure
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { check, runVerify } from "@noddle/testing";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const DOCKERFILES = ["apps/dashboard/Dockerfile", "apps/worker/Dockerfile"];

function workspaceMembers(): string[] {
  const dirs = (group: string) =>
    readdirSync(join(REPO_ROOT, group), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${group}/${entry.name}`)
      .filter((member) => existsSync(join(REPO_ROOT, member, "package.json")));

  return [...dirs("apps"), ...dirs("packages")].toSorted();
}

await runVerify("Dockerfile workspace manifests", () => {
  const members = workspaceMembers();

  check(`workspace has members (${members.length})`, members.length >= 10);

  for (const dockerfile of DOCKERFILES) {
    const content = readFileSync(join(REPO_ROOT, dockerfile), "utf-8");

    for (const member of members) {
      check(
        `${dockerfile} copies ${member}/package.json`,
        content.includes(`COPY ${member}/package.json ${member}/`)
      );
    }
  }
});
