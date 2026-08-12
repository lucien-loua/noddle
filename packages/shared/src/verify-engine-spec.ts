// bun run packages/shared/src/verify-engine-spec.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  connectionUrlFor,
  DATABASE_PORT,
  DEFAULT_DATABASE_IMAGE,
  ENGINE_SPECS,
} from "@noddle/database-spec";
import { check, runVerify } from "#verify-harness";

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
  const sharedEngines = readFileSync(
    join(REPO, "shared/src/database-engines.ts"),
    "utf8"
  );
  const connectionUrl = readFileSync(
    join(REPO, "../apps/web/src/server/databases/connection-url.ts"),
    "utf8"
  );

  check(
    "database-engines re-exports ENGINE_SPECS",
    sharedEngines.includes('from "@noddle/database-spec"')
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
});
