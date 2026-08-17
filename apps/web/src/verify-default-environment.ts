// tier: pure
// bun run apps/web/src/verify-default-environment.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { check, expectThrows, runVerify } from "@noddle/testing";

import { assertNotDefaultEnvironment } from "@/lib/environment-guard";

const ROOT = join(import.meta.dirname, "../../..");
const WEB_SRC = join(import.meta.dirname);
const DB = join(ROOT, "packages/db/src");

await runVerify("default environment (cannot delete)", () => {
  assertNotDefaultEnvironment({ isDefault: false }, "delete");
  check("non-default can be deleted", true);
  assertNotDefaultEnvironment({ isDefault: false }, "rename");
  check("non-default can be renamed", true);

  expectThrows(
    "default cannot be deleted",
    () => assertNotDefaultEnvironment({ isDefault: true }, "delete"),
    (e) => e instanceof Error && e.message === "you cannot delete the default environment",
  );
  expectThrows(
    "default cannot be renamed",
    () => assertNotDefaultEnvironment({ isDefault: true }, "rename"),
    (e) => e instanceof Error && e.message === "you cannot rename the default environment",
  );

  const environments = readFileSync(join(WEB_SRC, "server/environments.ts"), "utf-8");
  check(
    "deleteEnvironment calls the default guard",
    environments.includes('assertNotDefaultEnvironment(environment, "delete")'),
  );
  check(
    "renameEnvironment calls the default guard",
    environments.includes('assertNotDefaultEnvironment(environment, "rename")'),
  );

  const selector = readFileSync(join(WEB_SRC, "components/environment-selector.tsx"), "utf-8");
  check(
    "selector hides rename/delete on the default environment",
    selector.includes("env.isDefault ? null"),
  );

  const insertCallers = [
    "server/projects.ts",
    "server/environments.ts",
    "server/services.ts",
    "server/stacks.ts",
    "server/databases/connect.ts",
  ];
  for (const file of insertCallers) {
    check(
      `${file} inserts via insertProjectEnvironment`,
      readFileSync(join(WEB_SRC, file), "utf-8").includes("insertProjectEnvironment"),
    );
  }

  const migration = readFileSync(join(DB, "migrations/0049_environment_is_default.sql"), "utf-8");
  check("0049 adds is_default", migration.includes('ADD COLUMN "is_default"'));
  check(
    "0049 backfills one default per project",
    migration.includes("DISTINCT ON") && migration.includes("is_default"),
  );
  check(
    "0049 recreates production for empty projects",
    migration.includes('INSERT INTO "environments"') && migration.includes("'production'"),
  );
  check(
    "0049 snapshot exists",
    readFileSync(join(DB, "migrations/meta/0049_snapshot.json"), "utf-8").includes('"is_default"'),
  );
});
