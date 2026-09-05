// tier: pure
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { check, runVerify } from "@noddle/testing";

const WORKER_SRC = join(import.meta.dirname, "..");

const read = (path: string) => readFileSync(join(WORKER_SRC, path), "utf-8");

await runVerify("engine knowledge stays on ENGINE_SPECS", () => {
  const password = read("database/database-password.ts");
  const runtime = read("database/runtime.ts");
  const backupSubject = read("backup-run/subjects/database.ts");
  const restore = read("backup-run/subjects/database-restore.ts");

  check(
    "password change uses passwordChangeFor",
    password.includes("passwordChangeFor")
  );
  check(
    "password change has no engine switch of its own",
    !(
      password.includes("switch (engine)") ||
      password.includes("switch (database.engine)")
    )
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
    "dump uses dumpSpecFor rather than a table of its own",
    backupSubject.includes("dumpSpecFor") &&
      !backupSubject.includes("const DUMP_SPECS")
  );
  check(
    "restore uses restoreSpecFor rather than a table or a switch",
    restore.includes("restoreSpecFor") &&
      !restore.includes("const RESTORE_SPECS") &&
      !restore.includes("switch (database.engine)")
  );
});
