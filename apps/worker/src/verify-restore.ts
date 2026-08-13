// Restore, against REAL infrastructure — this is the test that decides
// whether backups are good for anything.
//
//   STACK_HOST=192.168.252.3 node apps/worker/src/verify-restore.ts
//
// "The job finishes without error" proves nothing. The only question that
// matters is: **is the data from before back, and is the data from after
// gone?** So every engine follows the same pattern:
//
//   marker BEFORE → backup → marker AFTER → restore
//   → BEFORE must be there, AFTER must not be there anymore.
//
// Redis goes through the trickiest path of this effort: it runs with
// `--appendonly yes`, so dropping an RDB and restarting restores NOTHING
// (measured). This file verifies it against a real instance.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type BackupDestination,
  backupObjectKey,
  deleteObject,
} from "@noddle/backup-store";
import { decryptSecret, encryptSecret, secretContext } from "@noddle/crypto";
import { createDatabase } from "@noddle/db";
import {
  backups,
  databases,
  environments,
  projects,
  s3Destinations,
  servers,
} from "@noddle/db/schema";
import {
  connect,
  disconnect,
  dockerClient,
  execArgv,
} from "@noddle/ssh-executor";
import { removeService } from "@noddle/swarm-ops";
import { eq, inArray } from "drizzle-orm";
import { runBackup } from "#backup";
import {
  findDatabaseContainer,
  legacyDatabaseServiceName,
} from "#backup-run/subjects/database";
import { provisionDatabase } from "#database";
import { runRestore } from "#restore";
import { seedSshKey, verifyCtx } from "#verify-seed";

const DB_URL =
  process.env.DATABASE_URL ??
  "postgres://postgres:noddle@localhost:55432/noddle";
const HOST = process.env.STACK_HOST ?? "192.168.252.3";
const USER = process.env.TARGET_USER ?? "ubuntu";
const KEY = process.env.SSH_KEY ?? join(homedir(), ".ssh", "id_ed25519");

const S3_ENDPOINT = process.env.S3_ENDPOINT ?? "http://localhost:9000";
const S3_KEY = process.env.S3_ACCESS_KEY ?? "rustfsadmin";
const S3_SECRET = process.env.S3_SECRET_KEY ?? "rustfsadmin";
const S3_BUCKET = process.env.S3_BUCKET ?? "noddle-verify";

const PG_NAME = "probe-restore-pg";
const REDIS_NAME = "probe-restore-redis";

let pass = 0;
let fail = 0;
const ok = (m: string) => {
  pass += 1;
  console.log(`  \x1b[32m✓\x1b[0m ${m}`);
};
const ko = (m: string) => {
  fail += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${m}`);
};

async function must(
  client: Awaited<ReturnType<typeof connect>>,
  argv: string[]
): Promise<string> {
  const r = await execArgv(client, argv);
  if (r.code !== 0) {
    throw new Error(
      `setup failed (code ${r.code}): ${argv.slice(0, 5).join(" ")} — ${r.stderr.slice(0, 300)}`
    );
  }
  return r.stdout;
}

const appKey = randomBytes(32);
const db = createDatabase({ url: DB_URL });
const privateKey = readFileSync(KEY, "utf8");
const sshKeyId = await seedSshKey(db, appKey, "verify-restore", privateKey);

let ssh: Awaited<ReturnType<typeof connect>> | undefined;

await db.delete(backups);
await db.delete(s3Destinations);
await db.delete(databases);
await db.delete(environments);
await db.delete(projects);
await db.delete(servers).where(inArray(servers.host, [HOST]));

console.log(`\n\x1b[1mRestore — VM ${HOST}, S3 ${S3_ENDPOINT}\x1b[0m`);

const destination: BackupDestination = {
  accessKeyId: S3_KEY,
  bucket: S3_BUCKET,
  endpoint: S3_ENDPOINT,
  forcePathStyle: true,
  prefix: "restaurations",
  region: "us-east-1",
  secretAccessKey: S3_SECRET,
};

try {
  const [server] = await db
    .insert(servers)
    .values({
      host: HOST,
      name: "restore-probe-manager",
      role: "manager",
      sshKeyId,
      sshUser: USER,
      status: "connected",
      totalMemoryMb: 2048,
    })
    .returning();
  if (!server) {
    throw new Error("server insertion failed");
  }

  const [dest] = await db
    .insert(s3Destinations)
    .values({
      accessKeyId: S3_KEY,
      bucket: S3_BUCKET,
      endpoint: S3_ENDPOINT,
      name: "verify",
      prefix: "restaurations",
      region: "us-east-1",
      secretAccessKeyEncrypted: "placeholder",
    })
    .returning();
  if (!dest) {
    throw new Error("destination insertion failed");
  }
  await db
    .update(s3Destinations)
    .set({
      secretAccessKeyEncrypted: encryptSecret(
        S3_SECRET,
        appKey,
        secretContext.backupDestination(dest.id)
      ),
    })
    .where(eq(s3Destinations.id, dest.id));

  const ctx = verifyCtx({ appKey, db });
  const route = { networkName: "noddle-public" };

  ssh = await connect({ host: HOST, privateKey, user: USER });
  const [proj] = await db
    .insert(projects)
    .values({ name: "restore-probe" })
    .returning();
  const [env] = await db
    .insert(environments)
    .values({ name: "production", projectId: proj?.id ?? "" })
    .returning();

  const provision = async (name: string, engine: "postgres" | "redis") => {
    if (!ssh) {
      throw new Error("no connection");
    }
    await removeService(dockerClient(ssh), legacyDatabaseServiceName(name));
    // The volume survives the service: without purging it, we'd inherit the
    // previous run and the test wouldn't start from the state it claims to.
    await execArgv(ssh, [
      "sh",
      "-c",
      `for i in $(seq 1 20); do docker volume rm ${legacyDatabaseServiceName(name)} >/dev/null 2>&1 && exit 0; sleep 1; done; exit 0`,
    ]);
    const [row] = await db
      .insert(databases)
      .values({
        engine,
        environmentId: env?.id ?? "",
        name,
        rootPasswordEncrypted: "placeholder",
        rootUser: engine === "postgres" ? "noddle" : null,
        serverId: server.id,
        swarmName: legacyDatabaseServiceName(name),
      })
      .returning();
    if (!row) {
      throw new Error(`database insertion ${name} failed`);
    }
    await db
      .update(databases)
      .set({
        rootPasswordEncrypted: encryptSecret(
          randomBytes(24).toString("hex"),
          appKey,
          secretContext.databasePassword(row.id)
        ),
      })
      .where(eq(databases.id, row.id));
    await provisionDatabase(ctx, route, row.id);
    return row;
  };

  const takeBackup = async (databaseId: string, name: string, ext: string) => {
    const [row] = await db
      .insert(backups)
      .values({
        databaseId,
        objectKey: backupObjectKey({
          backupId: randomBytes(6).toString("hex"),
          databaseName: name,
          extension: ext,
          prefix: "restaurations",
          takenAt: new Date(),
        }),
      })
      .returning();
    if (!row) {
      throw new Error("backup insertion failed");
    }
    await runBackup(ctx, row.id);
    return row;
  };

  // ═══ POSTGRES ═══════════════════════════════════════════════════════════
  const pg = await provision(PG_NAME, "postgres");
  ok("Postgres database provisioned");

  const pgContainer = await findDatabaseContainer(
    ssh,
    legacyDatabaseServiceName(PG_NAME)
  );
  const psql = (sql: string) => [
    "docker",
    "exec",
    pgContainer,
    "psql",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    "noddle",
    "-tA",
    "-c",
    sql,
  ];

  await must(ssh, psql("CREATE TABLE temoin(v text)"));
  await must(ssh, psql("INSERT INTO temoin VALUES ('avant')"));
  const pgBackup = await takeBackup(pg.id, PG_NAME, "dump");
  ok(`Postgres backup taken (${pgBackup.objectKey.split("/").pop()})`);

  await must(ssh, psql("INSERT INTO temoin VALUES ('apres')"));
  const before = await must(ssh, psql("SELECT v FROM temoin ORDER BY v"));
  ok(`state before restore: ${before.trim().split("\n").join(", ")}`);

  await runRestore(ctx, { backupId: pgBackup.id, databaseId: pg.id });
  const after = (await must(ssh, psql("SELECT v FROM temoin ORDER BY v")))
    .trim()
    .split("\n")
    .filter((l) => l !== "");

  if (after.length === 1 && after[0] === "avant") {
    ok('Postgres restored: "avant" came back, "apres" is gone');
  } else {
    ko(`Postgres poorly restored: ${JSON.stringify(after)}`);
  }

  const safety = await db.query.backups.findMany({
    where: eq(backups.kind, "pre_restore"),
  });
  if (safety.length === 1 && safety[0]?.status === "completed") {
    ok("a safety backup was taken before the restore");
  } else {
    ko(`safety backup missing or incomplete: ${safety.length}`);
  }

  // ═══ REFUS ══════════════════════════════════════════════════════════════
  const [failed] = await db
    .insert(backups)
    .values({
      databaseId: pg.id,
      objectKey: "restaurations/inexistant.dump",
      status: "failed",
    })
    .returning();
  try {
    await runRestore(ctx, { backupId: failed?.id ?? "", databaseId: pg.id });
    ko("a failed backup was accepted for restore");
  } catch {
    ok("a failed backup is refused");
  }

  // Object removed from the bucket by hand: the table says it exists, the
  // bucket says otherwise, and the bucket is right.
  const orphan = await takeBackup(pg.id, PG_NAME, "dump");
  await deleteObject(destination, orphan.objectKey);
  try {
    await runRestore(ctx, { backupId: orphan.id, databaseId: pg.id });
    ko("a restore started even though the object is missing");
  } catch {
    ok("object missing from the bucket: refused BEFORE touching the database");
  }
  const stillThere = (await must(ssh, psql("SELECT v FROM temoin ORDER BY v")))
    .trim()
    .split("\n")
    .filter((l) => l !== "");
  if (stillThere.length === 1 && stillThere[0] === "avant") {
    ok("the database is intact after the refusal");
  } else {
    ko(`the database was damaged by a refused restore: ${stillThere}`);
  }

  // ═══ REDIS — the AOF trap ═══════════════════════════════════════════════
  const rd = await provision(REDIS_NAME, "redis");
  ok("Redis database provisioned");

  const rdRow = await db.query.databases.findFirst({
    where: eq(databases.id, rd.id),
  });
  const redisContainer = await findDatabaseContainer(
    ssh,
    legacyDatabaseServiceName(REDIS_NAME)
  );
  // The password is the one Noddle generated: it's re-read through the same
  // path as the worker instead of inventing a new one.
  const redisPassword = decryptSecret(
    rdRow?.rootPasswordEncrypted ?? "",
    appKey,
    secretContext.databasePassword(rd.id)
  );
  const redis = (...args: string[]) => [
    "docker",
    "exec",
    "-e",
    `REDISCLI_AUTH=${redisPassword}`,
    redisContainer,
    "redis-cli",
    ...args,
  ];

  await must(ssh, redis("SET", "avant", "oui"));
  const rdBackup = await takeBackup(rd.id, REDIS_NAME, "rdb");
  ok("Redis backup taken");

  await must(ssh, redis("SET", "apres", "oui"));
  const rBefore = (await must(ssh, redis("KEYS", "*")))
    .trim()
    .split("\n")
    .sort();
  ok(`state before restore: ${rBefore.join(", ")}`);

  await runRestore(ctx, { backupId: rdBackup.id, databaseId: rd.id });

  // The container changed: the service was torn down and relaunched.
  const redisAfterContainer = await findDatabaseContainer(
    ssh,
    legacyDatabaseServiceName(REDIS_NAME)
  );
  const redis2 = (...args: string[]) => [
    "docker",
    "exec",
    "-e",
    `REDISCLI_AUTH=${redisPassword}`,
    redisAfterContainer,
    "redis-cli",
    ...args,
  ];
  const rAfter = (await must(ssh, redis2("KEYS", "*")))
    .trim()
    .split("\n")
    .filter((l) => l !== "")
    .sort();

  if (rAfter.length === 1 && rAfter[0] === "avant") {
    ok('Redis restored: "avant" came back, "apres" is gone');
  } else {
    ko(
      `Redis poorly restored: ${JSON.stringify(rAfter)} — did the AOF win over the RDB?`
    );
  }
} catch (err) {
  ko(`exception: ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof Error && err.stack) {
    console.log(err.stack.split("\n").slice(1, 5).join("\n"));
  }
} finally {
  if (ssh) {
    for (const n of [PG_NAME, REDIS_NAME]) {
      // biome-ignore lint/performance/noAwaitInLoops: intentional sequential cleanup
      await removeService(
        dockerClient(ssh),
        legacyDatabaseServiceName(n)
      ).catch(() => {
        // cleanup must not mask a real failure
      });
    }
    disconnect(ssh);
  }
}

console.log(`\n\x1b[1mpassed ${pass}, failed ${fail}\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
