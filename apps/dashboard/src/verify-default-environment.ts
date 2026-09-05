// tier: pure
import { readdirSync, readFileSync } from "node:fs";
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
    (e) =>
      e instanceof Error &&
      e.message === "you cannot delete the default environment"
  );
  expectThrows(
    "default cannot be renamed",
    () => assertNotDefaultEnvironment({ isDefault: true }, "rename"),
    (e) =>
      e instanceof Error &&
      e.message === "you cannot rename the default environment"
  );

  const environments = readFileSync(
    join(WEB_SRC, "server/environments.ts"),
    "utf-8"
  );
  check(
    "deleteEnvironment calls the default guard",
    environments.includes('assertNotDefaultEnvironment(environment, "delete")')
  );
  check(
    "renameEnvironment calls the default guard",
    environments.includes('assertNotDefaultEnvironment(environment, "rename")')
  );

  const selector = readFileSync(
    join(WEB_SRC, "components/environment-selector.tsx"),
    "utf-8"
  );
  check(
    "selector hides rename/delete on the default environment",
    selector.includes("env.isDefault ? null")
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
      readFileSync(join(WEB_SRC, file), "utf-8").includes(
        "insertProjectEnvironment"
      )
    );
  }

  const migrationsDir = join(DB, "migrations");
  const migrationSql = readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .map((file) => readFileSync(join(migrationsDir, file), "utf-8"))
    .join("\n");
  check(
    "a migration declares is_default, NOT NULL with a default",
    migrationSql.includes('"is_default" boolean DEFAULT false NOT NULL')
  );

  const journal = JSON.parse(
    readFileSync(join(migrationsDir, "meta/_journal.json"), "utf-8")
  ) as { entries: { idx: number; tag: string }[] };
  const latest = journal.entries.at(-1);
  check("the journal has at least one migration", latest !== undefined);

  const snapshot = JSON.parse(
    readFileSync(
      join(
        migrationsDir,
        `meta/${String(latest?.idx ?? 0).padStart(4, "0")}_snapshot.json`
      ),
      "utf-8"
    )
  ) as {
    tables: Record<
      string,
      { columns: Record<string, { default?: unknown; notNull?: boolean }> }
    >;
  };
  const column = snapshot.tables["public.environments"]?.columns.is_default;
  check(
    "the latest snapshot carries environments.is_default",
    column?.notNull === true && column.default === false
  );

  const insert = readFileSync(
    join(WEB_SRC, "lib/environment.server.ts"),
    "utf-8"
  );
  check(
    "the first environment of a project becomes its default",
    insert.includes("isDefault: !existingDefault")
  );
  const parameters = insert.slice(
    insert.indexOf("insertProjectEnvironment(values: {"),
    insert.indexOf("}): Promise")
  );
  check(
    "a caller cannot pass isDefault — the insert decides",
    parameters.length > 0 && !parameters.includes("isDefault")
  );
});
