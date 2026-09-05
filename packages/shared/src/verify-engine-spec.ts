// tier: pure
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { check, runVerify } from "@noddle/testing";

import {
  connectionUrlFor,
  DATABASE_PORT,
  DEFAULT_DATABASE_IMAGE,
  ENGINE_SPECS,
  passwordChangeFor,
} from "#database-spec";

const REPO = join(import.meta.dirname, "../..");

await runVerify("EngineSpec ownership (C5)", () => {
  check(
    "postgres image lives on ENGINE_SPECS",
    ENGINE_SPECS.postgres.image === DEFAULT_DATABASE_IMAGE.postgres
  );
  check(
    "postgres port is derived from ENGINE_SPECS table",
    ENGINE_SPECS.postgres.port === DATABASE_PORT.postgres
  );
  check(
    "postgres connection URL uses engine spec",
    connectionUrlFor("postgres", {
      databaseName: "app",
      host: "db.example",
      password: "secret",
      rootUser: "postgres",
    }) === "postgresql://postgres:secret@db.example:5432/app"
  );
  check(
    "redis connection URL uses engine spec",
    connectionUrlFor("redis", {
      databaseName: null,
      host: "db.example",
      password: "secret",
      rootUser: null,
    }) === "redis://default:secret@db.example:6379"
  );

  const engines = readFileSync(
    join(REPO, "shared/src/database-spec.ts"),
    "utf-8"
  );
  const dumpSpec = readFileSync(join(REPO, "backup/src/dump-spec.ts"), "utf-8");
  const restoreSpec = readFileSync(
    join(REPO, "backup/src/restore-spec.ts"),
    "utf-8"
  );
  const connectionUrl = readFileSync(
    join(REPO, "../apps/dashboard/src/server/databases/connection-url.ts"),
    "utf-8"
  );
  const password = readFileSync(
    join(REPO, "../apps/worker/src/database/database-password.ts"),
    "utf-8"
  );
  const backupSubject = readFileSync(
    join(REPO, "../apps/worker/src/backup-run/subjects/database.ts"),
    "utf-8"
  );
  const restore = readFileSync(
    join(REPO, "../apps/worker/src/backup-run/subjects/database-restore.ts"),
    "utf-8"
  );
  const runtime = readFileSync(
    join(REPO, "../apps/worker/src/database/runtime.ts"),
    "utf-8"
  );

  check(
    "shared has no database-engines facade",
    !existsSync(join(REPO, "shared/src/database-engines.ts"))
  );
  check(
    "DatabaseEngine lives on database-spec",
    engines.includes("export type DatabaseEngine")
  );
  check(
    "DATABASE_ENGINES lives on database-spec",
    engines.includes("export const DATABASE_ENGINES")
  );
  check(
    "ENGINE_SPECS owns DEFAULT_DATABASE_IMAGE",
    engines.includes("export const DEFAULT_DATABASE_IMAGE")
  );
  check(
    "web connection-url delegates to connectionUrlFor",
    connectionUrl.includes("connectionUrlFor")
  );
  check(
    "web connection-url has no engine switch",
    !connectionUrl.includes("switch (engine)")
  );

  const pgChange = passwordChangeFor("postgres", {
    password: "new-secret",
    rootUser: "postgres",
  });
  check(
    "passwordChange lives on ENGINE_SPECS",
    pgChange.script.includes("psql") && pgChange.input.includes("ALTER USER")
  );
  check(
    "worker password change has no engine switch",
    !(
      password.includes("switch (engine)") ||
      password.includes("switch (database.engine)")
    )
  );
  check(
    "worker password change uses passwordChangeFor",
    password.includes("passwordChangeFor")
  );
  check(
    "password change does not import backup-run",
    !password.includes("#backup-run")
  );
  check(
    "password change uses #database-runtime",
    password.includes("#database-runtime")
  );
  check(
    "findDatabaseContainer lives in database runtime",
    runtime.includes("export async function findDatabaseContainer")
  );
  check(
    "dump specs live in @noddle/backup/dump-spec",
    dumpSpec.includes("export function dumpSpecFor") &&
      dumpSpec.includes("pg_dump")
  );
  check(
    "worker dump uses dumpSpecFor",
    backupSubject.includes("dumpSpecFor") &&
      !backupSubject.includes("const DUMP_SPECS")
  );
  check(
    "restore specs live in @noddle/backup/restore-spec",
    restoreSpec.includes("export function restoreSpecFor") &&
      restoreSpec.includes("pg_restore")
  );
  check(
    "worker restore uses restoreSpecFor",
    restore.includes("restoreSpecFor") &&
      !restore.includes("const RESTORE_SPECS") &&
      !restore.includes("switch (database.engine)")
  );
  check(
    "every engine owns a passwordChange path",
    Object.values(ENGINE_SPECS).every((s) => Boolean(s.passwordChange))
  );
});
