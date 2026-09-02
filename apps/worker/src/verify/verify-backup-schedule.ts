// tier: vm
import { randomBytes } from "node:crypto";

import { backupObjectKey, objectExists } from "@noddle/backup-store";
import type { BackupDestination } from "@noddle/backup-store";
import { encryptSecret, secretContext } from "@noddle/crypto";
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
import {
  connect,
  disconnect,
  dockerClient,
  execArgv,
} from "@noddle/ssh-executor";
import { removeService } from "@noddle/swarm-ops";
import { devStack } from "@noddle/testing/dev-stack";
import { devTarget } from "@noddle/testing/dev-target";
import { eq, inArray } from "drizzle-orm";

import { runBackup } from "#backup";
import { pruneBackups, sweepBackups } from "#backup-sweep";
import { provisionDatabase } from "#database";
import { legacyDatabaseServiceName } from "#database-runtime";
import { seedSshKey, verifyCtx, verifyBuild } from "#verify-seed";

const TARGET = devTarget();

const DB_URL = devStack().databaseUrl;

const S3_ENDPOINT = devStack().s3.endpoint;
const S3_KEY = devStack().s3.accessKeyId;
const S3_SECRET = devStack().s3.secretAccessKey;
const S3_BUCKET = devStack().s3.bucket;

const NAME = "probe_planif";
const PREFIX = "planif";

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

const appKey = randomBytes(32);
const db = createDatabase({ url: DB_URL });
const { privateKey } = TARGET;
const sshKeyId = await seedSshKey(
  db,
  appKey,
  "verify-backup-schedule",
  privateKey
);

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

console.log(`\n\u001B[1mScheduling and retention — VM ${TARGET.host}\u001B[0m`);

const destination: BackupDestination = {
  accessKeyId: S3_KEY,
  bucket: S3_BUCKET,
  endpoint: S3_ENDPOINT,
  forcePathStyle: true,
  prefix: PREFIX,
  region: "us-east-1",
  secretAccessKey: S3_SECRET,
};

try {
  const [server] = await db
    .insert(servers)
    .values({
      host: TARGET.host,
      name: "planif-probe-manager",
      role: "manager",
      sshKeyId,
      sshUser: TARGET.user,
      status: "connected",
      totalMemoryMb: 2048,
    })
    .returning();
  if (!server) {
    throw new Error("server insert failed");
  }

  const [dest] = await db
    .insert(s3Destinations)
    .values({
      accessKeyId: S3_KEY,
      bucket: S3_BUCKET,
      endpoint: S3_ENDPOINT,
      name: "verify",
      prefix: PREFIX,
      region: "us-east-1",
      secretAccessKeyEncrypted: "placeholder",
    })
    .returning();
  if (!dest) {
    throw new Error("destination insert failed");
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
  await removeService(dockerClient(ssh), legacyDatabaseServiceName(NAME));
  await execArgv(ssh, [
    "sh",
    "-c",
    `for i in $(seq 1 20); do docker volume rm ${legacyDatabaseServiceName(NAME)} >/dev/null 2>&1 && exit 0; sleep 1; done; exit 0`,
  ]);

  const [proj] = await db
    .insert(projects)
    .values({ name: "planif-probe" })
    .returning();
  const [env] = await db
    .insert(environments)
    .values({ name: "production", projectId: proj?.id ?? "" })
    .returning();

  const [database] = await db
    .insert(databases)
    .values({
      databaseName: NAME,
      engine: "postgres",
      environmentId: env?.id ?? "",
      name: NAME,
      rootPasswordEncrypted: "placeholder",
      rootUser: "noddle",
      serverId: server.id,
      swarmName: legacyDatabaseServiceName(NAME),
    })
    .returning();
  if (!database) {
    throw new Error("database insert failed");
  }
  await db
    .update(databases)
    .set({
      rootPasswordEncrypted: encryptSecret(
        randomBytes(24).toString("hex"),
        appKey,
        secretContext.databasePassword(database.id)
      ),
    })
    .where(eq(databases.id, database.id));

  await provisionDatabase(
    ctx,
    route,
    verifyBuild("backup-schedule"),
    database.id
  );
  ok("Postgres database provisioned");

  const queued: string[] = [];
  const enqueue = async (id: string) => {
    queued.push(id);
    return await Promise.resolve(id);
  };

  let r = await sweepBackups(ctx, enqueue);
  if (r.queued.length === 0) {
    ok("a database with no backup config is never backed up");
  } else {
    ko(`unexpected ${r.queued.length} backup(s) without a config`);
  }

  const [config] = await db
    .insert(backupConfigs)
    .values({
      databaseId: database.id,
      databaseName: NAME,
      destinationId: dest.id,
      enabled: true,
      keepLatestCount: 2,
      prefix: "",
      schedule: "0 0 * * *",
    })
    .returning();
  if (!config) {
    throw new Error("backup config insert failed");
  }

  r = await sweepBackups(ctx, enqueue);
  if (r.queued.length === 1) {
    ok("a never-backed-up daily config is due immediately");
  } else {
    ko(`expected 1 due backup, got ${r.queued.length}`);
  }

  const firstId = r.queued[0] ?? "";
  await runBackup(ctx, firstId);
  ok("the scheduled backup runs and succeeds");

  r = await sweepBackups(ctx, enqueue);
  if (r.queued.length === 0) {
    ok("a just-backed-up database is not re-triggered");
  } else {
    ko(`spurious re-trigger: ${r.queued.length}`);
  }

  await db
    .update(backups)
    .set({ createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) })
    .where(eq(backups.id, firstId));
  r = await sweepBackups(ctx, enqueue);
  if (r.queued.length === 1) {
    ok("a 25 h-old backup makes the database due again");
  } else {
    ko(`expected 1 after aging, got ${r.queued.length}`);
  }
  await runBackup(ctx, r.queued[0] ?? "");

  const oldest = await db.query.backups.findFirst({
    where: eq(backups.id, firstId),
  });
  const oldestKey = oldest?.objectKey ?? "";
  if (await objectExists(destination, oldestKey)) {
    ok("the oldest backup is present in the bucket");
  } else {
    ko("the oldest backup is already missing");
  }

  const [third] = await db
    .insert(backups)
    .values({
      configId: config.id,
      databaseId: database.id,
      destinationId: dest.id,
      objectKey: backupObjectKey({
        backupId: randomBytes(6).toString("hex"),
        databaseName: NAME,
        extension: "dump",
        prefix: PREFIX,
        takenAt: new Date(),
      }),
    })
    .returning();
  await runBackup(ctx, third?.id ?? "");

  const remaining = await db.query.backups.findMany({
    where: eq(backups.configId, config.id),
  });
  const completed = remaining.filter((b) => b.status === "completed");
  if (completed.length === 2) {
    ok(`retention respected: ${completed.length} backups kept out of 3`);
  } else {
    ko(`retention not respected: ${completed.length} kept, expected 2`);
  }

  if (await objectExists(destination, oldestKey)) {
    ko("DANGER: the row was pruned but the OBJECT remained in the bucket");
  } else {
    ok("the pruned backup's object was removed from the bucket");
  }

  let allPresent = true;
  for (const b of completed) {
    if (!(await objectExists(destination, b.objectKey))) {
      allPresent = false;
    }
  }
  if (allPresent) {
    ok("kept backups all still have their object");
  } else {
    ko("a kept backup lost its object");
  }

  const again = await pruneBackups(ctx, {
    configId: config.id,
    databaseId: database.id,
  });
  if (again.length === 0) {
    ok("a second prune deletes nothing more");
  } else {
    ko(`second prune deleted ${again.length} extra object(s)`);
  }
} catch (error) {
  ko(`exception: ${error instanceof Error ? error.message : String(error)}`);
  if (error instanceof Error && error.stack) {
    console.log(error.stack.split("\n").slice(1, 5).join("\n"));
  }
} finally {
  if (ssh) {
    await removeService(
      dockerClient(ssh),
      legacyDatabaseServiceName(NAME)
    ).catch(() => {});
    disconnect(ssh);
  }
}

console.log(`\n\u001B[1mpassed ${pass}, failed ${fail}\u001B[0m\n`);
process.exit(fail === 0 ? 0 : 1);
