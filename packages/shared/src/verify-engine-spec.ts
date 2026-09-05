// tier: pure
import { readFileSync } from "node:fs";
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

  const dumpSpec = readFileSync(join(REPO, "backup/src/dump-spec.ts"), "utf-8");
  const restoreSpec = readFileSync(
    join(REPO, "backup/src/restore-spec.ts"),
    "utf-8"
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
    "dump specs live in @noddle/backup/dump-spec",
    dumpSpec.includes("export function dumpSpecFor") &&
      dumpSpec.includes("pg_dump")
  );
  check(
    "restore specs live in @noddle/backup/restore-spec",
    restoreSpec.includes("export function restoreSpecFor") &&
      restoreSpec.includes("pg_restore")
  );
  check(
    "every engine owns a passwordChange path",
    Object.values(ENGINE_SPECS).every((s) => Boolean(s.passwordChange))
  );
});
