// bun run packages/backup/src/verify.ts
// node packages/backup/src/verify.ts
import { check, expectThrows, runVerify } from "@noddle/testing";
import { dumpSpecFor } from "#dump-spec";
import { restoreSpecFor } from "#restore-spec";
import {
  BACKUP_EXTENSION,
  buildBackupInsert,
  joinBackupPrefix,
  pickDestination,
} from "#index";
import { isConfigDue } from "#schedule";

await runVerify("backup domain", () => {
  const a = { id: "a", prefix: "dest-a" };
  const b = { id: "b", prefix: "dest-b" };

  check(
    "postgres dump uses pg_dump",
    dumpSpecFor("postgres")
      .argv({
        containerId: "c1",
        databaseName: "app",
        rootUser: "postgres",
      })
      .includes("pg_dump")
  );
  check(
    "redis dump env carries REDISCLI_AUTH",
    dumpSpecFor("redis").env({
      databaseName: null,
      password: "secret",
      rootUser: null,
    }).REDISCLI_AUTH === "secret"
  );

  const ENGINES = ["postgres", "mysql", "mariadb", "mongo", "redis"] as const;
  check(
    "postgres restore spec exposes apply",
    typeof restoreSpecFor("postgres").apply === "function"
  );
  check(
    "restore spec table covers all five engines",
    ENGINES.every((e) => typeof restoreSpecFor(e).apply === "function")
  );

  expectThrows(
    "zero destinations: refused with a clear message",
    () => pickDestination([], null),
    (e) =>
      e instanceof Error && e.message.includes("no S3 destination configured")
  );

  const single = pickDestination([a], null);
  check(
    "single destination: returned without needing to choose",
    single.id === "a"
  );

  expectThrows(
    "two destinations, no choice: refused explicitly",
    () => pickDestination([a, b], null),
    (e) => e instanceof Error && e.message.includes("several S3 destinations")
  );

  const chosen = pickDestination([a, b], "b");
  check(
    "two destinations, explicit choice: returns the REQUESTED one",
    chosen.id === "b"
  );

  expectThrows(
    "an id absent from the candidates is refused with a clear message",
    () => pickDestination([a, b], "absent"),
    (e) => e instanceof Error && e.message.includes("no longer exists")
  );

  const missing = ENGINES.filter((e) => !(e in BACKUP_EXTENSION));
  check(
    "BACKUP_EXTENSION covers all five engines",
    missing.length === 0,
    missing.length ? missing.join(", ") : undefined
  );

  check(
    "mysql/mariadb do not inherit the rdb extension from the original ternary",
    BACKUP_EXTENSION.postgres === "dump" &&
      BACKUP_EXTENSION.redis === "rdb" &&
      BACKUP_EXTENSION.mysql !== "rdb" &&
      BACKUP_EXTENSION.mariadb !== "rdb"
  );

  const takenAt = new Date("2026-08-10T12:00:00.000Z");
  const insertA = buildBackupInsert({
    database: { engine: "mysql", id: "db-1", name: "shop" },
    kind: "manual",
    resolved: a,
    takenAt,
  });
  check(
    "buildBackupInsert aligns destinationId and the prefix IN the key",
    insertA.destinationId === "a" &&
      insertA.objectKey.startsWith("dest-a/shop/") &&
      insertA.objectKey.endsWith(".sql"),
    JSON.stringify(insertA)
  );

  const insertB = buildBackupInsert({
    database: { engine: "postgres", id: "db-2", name: "shop" },
    kind: "scheduled",
    resolved: b,
    takenAt,
  });
  check(
    "destinationId and prefix stay aligned for a second destination",
    insertB.destinationId === "b" && insertB.objectKey.startsWith("dest-b/"),
    JSON.stringify(insertB)
  );

  check(
    "joinBackupPrefix stacks destination and config prefixes",
    joinBackupPrefix("dest-a", "nightly") === "dest-a/nightly"
  );

  const insertC = buildBackupInsert({
    configId: "cfg-1",
    configPrefix: "nightly",
    database: { engine: "postgres", id: "db-3", name: "shop" },
    databaseName: "shop_db",
    kind: "scheduled",
    resolved: a,
    takenAt,
  });
  check(
    "buildBackupInsert honors configId, configPrefix and databaseName",
    insertC.configId === "cfg-1" &&
      insertC.objectKey.startsWith("dest-a/nightly/shop_db/"),
    JSON.stringify(insertC)
  );

  const hourly = "0 * * * *";
  const now = new Date("2026-08-12T12:30:00.000Z");
  check(
    "isConfigDue: first run when nothing completed yet",
    isConfigDue(hourly, null, now)
  );
  check(
    "isConfigDue: not due when last completed after previous cron fire",
    !isConfigDue(hourly, new Date("2026-08-12T12:05:00.000Z"), now)
  );
  check(
    "isConfigDue: due when last completed before previous cron fire",
    isConfigDue(hourly, new Date("2026-08-12T11:05:00.000Z"), now)
  );
  check(
    "isConfigDue: invalid cron returns false",
    !isConfigDue("not a cron", null, now)
  );
});
