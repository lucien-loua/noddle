// tier: pure
// bun run packages/database-spec/src/verify.ts
import { check, runVerify } from "@noddle/testing";

import { ENGINE_SPECS, reservedEnvKeys, secretPathFor } from "./index.ts";

await runVerify("database-spec", () => {
  check(
    "every engine has a secret file",
    Object.values(ENGINE_SPECS).every((s) => s.secretFile.length > 0)
  );
  check(
    "postgres secret path",
    secretPathFor("postgres") === "/run/secrets/postgres_password"
  );
  const keys = reservedEnvKeys("postgres", {
    databaseName: "app",
    rootUser: "postgres",
  });
  check(
    "postgres reserves POSTGRES_* keys",
    keys.includes("POSTGRES_PASSWORD_FILE") &&
      keys.includes("POSTGRES_USER") &&
      keys.includes("POSTGRES_DB")
  );
  check(
    "redis reserves no env keys",
    reservedEnvKeys("redis", { databaseName: null, rootUser: null }).length ===
      0
  );
  check(
    "mongo uses world-readable secret mode",
    ENGINE_SPECS.mongo.secretMode === 0o444
  );
});
