// tier: pure
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { check, runVerify, suite } from "@noddle/testing";

const ROOT = new URL("./", import.meta.url).pathname;
const SOURCE_FILE = /\.tsx?$/;
const BENCH_FILE = /(^|\/)verify-[^/]*\.ts$/;

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
  "routes/api/v1/deployments.$id.logs.ts",
  "routes/api/v1/deployments.$id.ts",
  "routes/api/v1/services.$id.deploy.ts",
  "routes/api/v1/services.ts",
  "server/containers.ts",
  "server/git-providers.ts",
  "server/servers.ts",
  "server/ssh-keys.ts",
];

const DELIBERATELY_UNSCOPED: Record<string, string> = {
  "lib/deploy-queue.server.ts":
    "enqueues work for an id its caller already authorized: a scoped loader, a verified webhook signature, or an API token",
  "lib/environment.server.ts":
    "reads only whether the project it is handed already has a default environment; every caller resolves that project through the team",
  "lib/installation-queries.server.ts":
    "one Traefik routes the whole installation, so a host is unique across every team",
  "lib/preview.server.ts":
    "reached only from signed forge webhooks, which act on every service that deploys the repository",
  "lib/webhook-intake.server.ts":
    "reached only from signed forge webhooks, which act on every service that deploys the repository",
  "routes/api/webhooks/service/$serviceId.ts":
    "authenticated by the service's own webhook secret; the caller is a forge, not a session, and has no team",
  "routes/api/webhooks/stack/$stackId.ts":
    "authenticated by the stack's own webhook secret; the caller is a forge, not a session, and has no team",
};

const SCOPE_MODULES: Record<string, string> = {
  "lib/guarded.server.ts": "verify-team-scope.ts",
  "lib/team-queries.server.ts": "verify-team-isolation.ts",
};

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return walk(path);
    }
    return SOURCE_FILE.test(path) ? [path] : [];
  });
}

const offenders = walk(ROOT)
  .map((path) => relative(ROOT, path))
  .filter((file) => !BENCH_FILE.test(file) && !(file in SCOPE_MODULES))
  .filter((file) => DIRECT_READ.test(readFileSync(join(ROOT, file), "utf-8")))
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

  await suite("a module that applies the scope names its proof", () => {
    for (const [module, bench] of Object.entries(SCOPE_MODULES)) {
      check(
        `${module} is proven by ${bench}`,
        existsSync(join(ROOT, module)) && existsSync(join(ROOT, bench)),
        "an exemption without a behavioural bench is an unchecked read"
      );
    }
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
