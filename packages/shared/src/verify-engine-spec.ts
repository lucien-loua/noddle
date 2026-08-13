// bun run packages/shared/src/verify-engine-spec.ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  connectionUrlFor,
  DATABASE_PORT,
  DEFAULT_DATABASE_IMAGE,
  ENGINE_SPECS,
  passwordChangeFor,
} from "@noddle/database-spec";
import { check, runVerify } from "@noddle/testing";

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
    join(REPO, "database-spec/src/index.ts"),
    "utf8"
  );
  const connectionUrl = readFileSync(
    join(REPO, "../apps/web/src/server/databases/connection-url.ts"),
    "utf8"
  );
  const password = readFileSync(
    join(REPO, "../apps/worker/src/database/database-password.ts"),
    "utf8"
  );
  const restore = readFileSync(
    join(REPO, "../apps/worker/src/backup-run/subjects/database-restore.ts"),
    "utf8"
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
    "restore dispatches via RESTORE_SPECS table",
    restore.includes("RESTORE_SPECS") &&
      !restore.includes("switch (database.engine)")
  );
  check(
    "every engine owns a passwordChange path",
    Object.values(ENGINE_SPECS).every((s) => Boolean(s.passwordChange))
  );
});
