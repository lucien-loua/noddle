// tier: pure
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { check, runVerify, suite } from "@noddle/testing";

const ROOT = new URL("./", import.meta.url).pathname;
const SCANNED = ["server", "routes/api"];

const TEAM_TABLES = [
  "projects",
  "environments",
  "services",
  "databases",
  "stacks",
  "deployments",
  "stackDeployments",
  "databaseDeployments",
  "backups",
  "backupConfigs",
  "volumeBackups",
  "volumeBackupConfigs",
  "envVars",
  "serviceDomains",
  "serviceDependencies",
];

const DIRECT_READ = new RegExp(
  `\\.query\\.(${TEAM_TABLES.join("|")})\\.find|\\.from\\((${TEAM_TABLES.join("|")})\\)`
);

const NOT_YET_SCOPED = [
  "routes/api/database-logs/$databaseId.ts",
  "routes/api/logs/$deploymentId.ts",
  "routes/api/service-logs/$serviceId.ts",
  "routes/api/v1/deployments.$id.logs.ts",
  "routes/api/v1/deployments.$id.ts",
  "routes/api/v1/services.$id.deploy.ts",
  "routes/api/v1/services.ts",
  "routes/api/webhooks/service/$serviceId.ts",
  "routes/api/webhooks/stack/$stackId.ts",
  "server/backups/configs.ts",
  "server/backups/destinations.ts",
  "server/backups/runs.ts",
  "server/backups/volume/configs.ts",
  "server/backups/volume/runs.ts",
  "server/backups/volume/volumes.server.ts",
  "server/containers.ts",
  "server/dashboard.ts",
  "server/databases/attach.ts",
  "server/databases/connect.ts",
  "server/databases/credentials.ts",
  "server/databases/read.ts",
  "server/dependencies.ts",
  "server/deployments.ts",
  "server/git-providers.ts",
  "server/registries.ts",
  "server/servers.ts",
  "server/service-domains.ts",
  "server/services.ts",
  "server/ssh-keys.ts",
  "server/stacks.ts",
  "server/webhooks.ts",
];

const DELIBERATELY_UNSCOPED: Record<string, string> = {};

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return walk(path);
    }
    return path.endsWith(".ts") ? [path] : [];
  });
}

const offenders = SCANNED.flatMap((dir) => walk(join(ROOT, dir)))
  .filter((path) => DIRECT_READ.test(readFileSync(path, "utf-8")))
  .map((path) => relative(ROOT, path))
  .toSorted();

await runVerify("team scope ratchet", async () => {
  await suite("no new file reads a team's rows directly", () => {
    const known = new Set([
      ...NOT_YET_SCOPED,
      ...Object.keys(DELIBERATELY_UNSCOPED),
    ]);
    const fresh = offenders.filter((file) => !known.has(file));
    check(
      "every direct read is already on a list",
      fresh.length === 0,
      `new direct reads, scope them or justify them: ${fresh.join(", ")}`
    );
  });

  await suite("the to-do list only shrinks", () => {
    const stale = NOT_YET_SCOPED.filter((file) => !offenders.includes(file));
    check(
      "nothing on the list is already done",
      stale.length === 0,
      `scoped now, remove from NOT_YET_SCOPED: ${stale.join(", ")}`
    );
    check(
      "remaining",
      true,
      `${NOT_YET_SCOPED.length} file(s) still read team rows directly`
    );
  });
});
