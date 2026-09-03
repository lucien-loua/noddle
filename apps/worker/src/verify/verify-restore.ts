// tier: vm
import { randomBytes } from "node:crypto";

import { backupObjectKey, deleteObject } from "@noddle/backup";
import type { BackupDestination } from "@noddle/backup";
import { decryptSecret, encryptSecret, secretContext } from "@noddle/crypto";
import { createDatabase } from "@noddle/db";
import {
  backupConfigs,
  backups,
  databases,
  environments,
  projects,
  s3Destinations,
  servers,
  volumeBackupConfigs,
  volumeBackups,
} from "@noddle/db/schema";
import { removeService, removeSecretIfExists } from "@noddle/deploy-engine/ops";
import {
  connect,
  disconnect,
  dockerClient,
  execArgv,
} from "@noddle/ssh-executor";
import { devStack } from "@noddle/testing/dev-stack";
import { devTarget } from "@noddle/testing/dev-target";
import { eq, inArray } from "drizzle-orm";

import { runBackup } from "#backup";
import { provisionDatabase } from "#database";
import {
  findDatabaseContainer,
  legacyDatabaseServiceName,
} from "#database-runtime";
import { runRestore } from "#restore";
import { seedSshKey, verifyCtx, verifyBuild } from "#verify-seed";

const DB_URL = devStack().databaseUrl;
const TARGET = devTarget();

const S3_ENDPOINT = devStack().s3.endpoint;
const S3_KEY = devStack().s3.accessKeyId;
const S3_SECRET = devStack().s3.secretAccessKey;
const S3_BUCKET = devStack().s3.bucket;

const PG_NAME = "probe-restore-pg";
const REDIS_NAME = "probe_restore_redis";

let pass = 0;
let fail = 0;
const ok = (m: string) => {
  pass += 1;
  console.log(`  \u001B[32m✓\u001B[0m ${m}`);
};
const ko = (m: string) => {
  fail += 1;
  console.log(`  \u001B[31m✗\u001B[0m ${m}`);
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
const { privateKey } = TARGET;
const sshKeyId = await seedSshKey(db, appKey, "verify-restore", privateKey);

let ssh: Awaited<ReturnType<typeof connect>> | undefined;

await db.delete(backups);
await db.delete(backupConfigs);
await db.delete(volumeBackups);
await db.delete(volumeBackupConfigs);
await db.delete(s3Destinations);
await db.delete(databases);
await db.delete(environments);
await db.delete(projects);
await db.delete(servers).where(inArray(servers.host, [TARGET.host]));

console.log(
  `\n\u001B[1mRestore — VM ${TARGET.host}, S3 ${S3_ENDPOINT}\u001B[0m`
);

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
      host: TARGET.host,
      name: "restore-probe-manager",
      role: "manager",
      sshKeyId,
      sshUser: TARGET.user,
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

  ssh = await connect({ host: TARGET.host, privateKey, user: TARGET.user });
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
    await execArgv(ssh, [
      "sh",
      "-c",
      `for i in $(seq 1 20); do docker volume rm ${legacyDatabaseServiceName(name)} >/dev/null 2>&1 && exit 0; sleep 1; done; exit 0`,
    ]);
    await removeSecretIfExists(
      dockerClient(ssh),
      `${legacyDatabaseServiceName(name)}-password`
    );
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
    await provisionDatabase(ctx, route, verifyBuild("restore"), row.id);
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

  const rd = await provision(REDIS_NAME, "redis");
  ok("Redis database provisioned");

  const rdRow = await db.query.databases.findFirst({
    where: eq(databases.id, rd.id),
  });
  const redisContainer = await findDatabaseContainer(
    ssh,
    legacyDatabaseServiceName(REDIS_NAME)
  );
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
    .toSorted();
  ok(`state before restore: ${rBefore.join(", ")}`);

  await runRestore(ctx, { backupId: rdBackup.id, databaseId: rd.id });

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
    .toSorted();

  if (rAfter.length === 1 && rAfter[0] === "avant") {
    ok('Redis restored: "avant" came back, "apres" is gone');
  } else {
    ko(
      `Redis poorly restored: ${JSON.stringify(rAfter)} — did the AOF win over the RDB?`
    );
  }
} catch (error) {
  ko(`exception: ${error instanceof Error ? error.message : String(error)}`);
  if (error instanceof Error && error.stack) {
    console.log(error.stack.split("\n").slice(1, 5).join("\n"));
  }
} finally {
  if (ssh) {
    for (const n of [PG_NAME, REDIS_NAME]) {
      await removeService(
        dockerClient(ssh),
        legacyDatabaseServiceName(n)
      ).catch(() => {});
      await removeSecretIfExists(
        dockerClient(ssh),
        `${legacyDatabaseServiceName(n)}-password`
      ).catch(() => {});
    }
    disconnect(ssh);
  }
}

console.log(`\n\u001B[1mpassed ${pass}, failed ${fail}\u001B[0m\n`);
process.exit(fail === 0 ? 0 : 1);
