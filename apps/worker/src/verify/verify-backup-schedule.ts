// STACK_HOST=192.168.252.3 node apps/worker/src/verify/verify-backup-schedule.ts
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type BackupDestination,
  backupObjectKey,
  objectExists,
} from "@noddle/backup-store";
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
import { legacyDatabaseServiceName } from "#database-runtime";
import { pruneBackups, sweepBackups } from "#backup-sweep";
import { provisionDatabase } from "#database";
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

const NAME = "probe-planif";
const PREFIX = "planif";

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

const appKey = randomBytes(32);
const db = createDatabase({ url: DB_URL });
const privateKey = readFileSync(KEY, "utf8");
const sshKeyId = await seedSshKey(
  db,
  appKey,
  "verify-backup-schedule",
  privateKey
);

let ssh: Awaited<ReturnType<typeof connect>> | undefined;

await db.delete(backups);
await db.delete(s3Destinations);
await db.delete(databases);
await db.delete(environments);
await db.delete(projects);
await db.delete(servers).where(inArray(servers.host, [HOST]));

console.log(`\n\x1b[1mScheduling and retention — VM ${HOST}\x1b[0m`);

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
      host: HOST,
      name: "planif-probe-manager",
      role: "manager",
      sshKeyId,
      sshUser: USER,
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

  ssh = await connect({ host: HOST, privateKey, user: USER });
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

  await provisionDatabase(ctx, route, database.id);
  ok("Postgres database provisioned");

  const queued: string[] = [];
  const enqueue = async (id: string) => {
    queued.push(id);
    return await Promise.resolve(id);
  };

  // ── 1. No config triggers NOTHING ───────────────────────────────────────
  let r = await sweepBackups(ctx, enqueue);
  if (r.queued.length === 0) {
    ok("a database with no backup config is never backed up");
  } else {
    ko(`unexpected ${r.queued.length} backup(s) without a config`);
  }

  // ── 2. Enabled daily cron with no history IS due ────────────────────────
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

  // The sweep ENQUEUES; the worker runs it. Here we run it ourselves,
  // otherwise the row would stay `queued` and the next test would think
  // the database is still due.
  const firstId = r.queued[0] ?? "";
  await runBackup(ctx, firstId);
  ok("the scheduled backup runs and succeeds");

  // ── 3. A freshly backed-up database is NO LONGER due ─────────────────────
  r = await sweepBackups(ctx, enqueue);
  if (r.queued.length === 0) {
    ok("a just-backed-up database is not re-triggered");
  } else {
    ko(`spurious re-trigger: ${r.queued.length}`);
  }

  // ── 4. Aging the backup makes it due again ───────────────────────────────
  // We rewind the date in the DB rather than waiting 24 h: it's the SAME
  // column the sweep reads, so the path under test is the real one.
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

  // ── 5. Retention deletes the OBJECT, not just the row ────────────────────
  // Retention = 2. We create a third successful backup; the oldest must
  // disappear from the bucket.
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

  // ── 6. Prune does not touch what we keep ─────────────────────────────────
  let allPresent = true;
  for (const b of completed) {
    // biome-ignore lint/performance/noAwaitInLoops: sequential check intentional
    if (!(await objectExists(destination, b.objectKey))) {
      allPresent = false;
    }
  }
  if (allPresent) {
    ok("kept backups all still have their object");
  } else {
    ko("a kept backup lost its object");
  }

  // ── 7. An idempotent prune ───────────────────────────────────────────────
  const again = await pruneBackups(ctx, {
    configId: config.id,
    databaseId: database.id,
  });
  if (again.length === 0) {
    ok("a second prune deletes nothing more");
  } else {
    ko(`second prune deleted ${again.length} extra object(s)`);
  }
} catch (err) {
  ko(`exception: ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof Error && err.stack) {
    console.log(err.stack.split("\n").slice(1, 5).join("\n"));
  }
} finally {
  if (ssh) {
    await removeService(
      dockerClient(ssh),
      legacyDatabaseServiceName(NAME)
    ).catch(() => {
      // cleanup must not mask a real failure
    });
    disconnect(ssh);
  }
}

console.log(`\n\x1b[1mpassed ${pass}, failed ${fail}\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
