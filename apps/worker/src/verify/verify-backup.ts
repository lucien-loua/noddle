// tier: vm
// node apps/worker/src/verify/verify-backup.ts
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { backupObjectKey, checkDestination, objectExists } from "@noddle/backup-store";
import type { BackupDestination } from "@noddle/backup-store";
import { encryptSecret, secretContext } from "@noddle/crypto";
import { createDatabase } from "@noddle/db";
import {
  backups,
  databases,
  environments,
  projects,
  s3Destinations,
  servers,
} from "@noddle/db/schema";
import { connect, disconnect, dockerClient, execArgv } from "@noddle/ssh-executor";
import { removeService } from "@noddle/swarm-ops";
import { devStack } from "@noddle/testing/dev-stack";
import { devTarget } from "@noddle/testing/dev-target";
import { eq, inArray } from "drizzle-orm";

import { runBackup } from "#backup";
import { provisionDatabase } from "#database";
import { findDatabaseContainer, legacyDatabaseServiceName } from "#database-runtime";
import { seedSshKey, verifyCtx } from "#verify-seed";

const DB_URL = devStack().databaseUrl;
const TARGET = devTarget();

// RustFS runs on the dev machine; the VM must be able to reach it, so
// it is the worker (here) that talks to S3, never the target — which is
// exactly the topology we settled on.
const S3_ENDPOINT = devStack().s3.endpoint;
const S3_KEY = devStack().s3.accessKeyId;
const S3_SECRET = devStack().s3.secretAccessKey;
const S3_BUCKET = devStack().s3.bucket;

const NAME = "probe-sauvegarde";

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

/**
 * Setup command that MUST succeed.
 *
 * `execArgv` returns an exit code that nothing required us to read: a
 * `CREATE TABLE` failing on an already-present table went unnoticed, and the
 * test then measured a tiny dump while believing it was measuring a large one.
 * A harness that ignores its own setup failures reports results that do not
 * cover what it claims.
 */
async function must(client: Awaited<ReturnType<typeof connect>>, argv: string[]): Promise<string> {
  const r = await execArgv(client, argv);
  if (r.code !== 0) {
    throw new Error(
      `setup failed (code ${r.code}): ${argv.slice(0, 4).join(" ")} — ${r.stderr.slice(0, 300)}`,
    );
  }
  return r.stdout;
}

const appKey = randomBytes(32);
const db = createDatabase({ url: DB_URL });
const { privateKey } = TARGET;
const sshKeyId = await seedSshKey(db, appKey, "verify-backup", privateKey);

let ssh: Awaited<ReturnType<typeof connect>> | undefined;

await db.delete(backups);
await db.delete(s3Destinations);
await db.delete(databases);
await db.delete(environments);
await db.delete(projects);
await db.delete(servers).where(inArray(servers.host, [TARGET.host]));

console.log(`\n\u001B[1mBackups — VM ${TARGET.host}, S3 ${S3_ENDPOINT}\u001B[0m`);

try {
  const [server] = await db
    .insert(servers)
    .values({
      host: TARGET.host,
      name: "sauvegarde-probe-manager",
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
      prefix: "sauvegardes",
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
        secretContext.backupDestination(dest.id),
      ),
    })
    .where(eq(s3Destinations.id, dest.id));
  ok("S3 destination registered, secret key encrypted");

  // Noddle NEVER creates a bucket: it is a resource the user owns and names.
  // This script therefore does not claim a right the product does not have —
  // it fails with the next steps to follow.
  await checkDestination({
    accessKeyId: S3_KEY,
    bucket: S3_BUCKET,
    endpoint: S3_ENDPOINT,
    forcePathStyle: true,
    prefix: "sauvegardes",
    region: "us-east-1",
    secretAccessKey: S3_SECRET,
  });
  ok(`bucket "${S3_BUCKET}" reachable for writes`);

  const ctx = verifyCtx({ appKey, db });
  const route = { networkName: "noddle-public" };

  ssh = await connect({ host: TARGET.host, privateKey, user: TARGET.user });
  await removeService(dockerClient(ssh), legacyDatabaseServiceName(NAME));
  // The volume does NOT disappear with the service — that is the whole point
  // of a named volume. Without this purge, each run inherits the previous
  // run's tables and therefore does not start from the state it claims.
  await execArgv(ssh, [
    "sh",
    "-c",
    `for i in $(seq 1 20); do docker volume rm ${legacyDatabaseServiceName(NAME)} >/dev/null 2>&1 && exit 0; sleep 1; done; exit 0`,
  ]);

  const [proj] = await db.insert(projects).values({ name: "sauvegarde-probe" }).returning();
  const [env] = await db
    .insert(environments)
    .values({ name: "production", projectId: proj?.id ?? "" })
    .returning();

  // ── A real database, provisioned by Phase 2 code ─────────────────────────
  const password = randomBytes(24).toString("hex");
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
        password,
        appKey,
        secretContext.databasePassword(database.id),
      ),
    })
    .where(eq(databases.id, database.id));

  await provisionDatabase(ctx, route, database.id);
  ok("Postgres database provisioned on the VM");

  const containerId = await findDatabaseContainer(ssh, legacyDatabaseServiceName(NAME));
  ok(`container found by Swarm label: ${containerId.slice(0, 12)}`);

  // ── A witness, so the backup has verifiable content ──────────────────────
  const witness = randomBytes(8).toString("hex");
  await must(ssh, [
    "docker",
    "exec",
    containerId,
    "psql",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    "noddle",
    "-c",
    `CREATE TABLE temoin(v text); INSERT INTO temoin VALUES ('${witness}')`,
  ]);
  ok(`witness inserted: ${witness}`);

  const destination: BackupDestination = {
    accessKeyId: S3_KEY,
    bucket: S3_BUCKET,
    endpoint: S3_ENDPOINT,
    forcePathStyle: true,
    prefix: "sauvegardes",
    region: "us-east-1",
    secretAccessKey: S3_SECRET,
  };

  // ── 1. The happy path ────────────────────────────────────────────────────
  const keyOk = backupObjectKey({
    backupId: "temoin",
    databaseName: NAME,
    extension: "dump",
    prefix: "sauvegardes",
    takenAt: new Date(),
  });
  const [row] = await db
    .insert(backups)
    .values({ databaseId: database.id, objectKey: keyOk })
    .returning();
  if (!row) {
    throw new Error("backup insert failed");
  }

  await runBackup(ctx, row.id);
  const done = await db.query.backups.findFirst({
    where: eq(backups.id, row.id),
  });
  if (done?.status === "completed" && (done?.sizeBytes ?? 0) > 0) {
    ok(`backup succeeded: ${done.sizeBytes} bytes, status ${done.status}`);
  } else {
    ko(`status ${done?.status}, size ${done?.sizeBytes}`);
  }
  if (await objectExists(destination, keyOk)) {
    ok("the object is actually in the bucket");
  } else {
    ko("no object in the bucket despite a successful status");
  }

  // ── 2. THE test of this effort: a dump interrupted mid-flight ────────────
  // We grow the database so the dump takes time, then kill the container
  // while it is streaming. This is the real scenario — the OOM killer taking
  // out the database during a backup — and it produces exactly the dangerous
  // shape: valid bytes, a cleanly closed stream, incomplete content.
  await must(ssh, [
    "docker",
    "exec",
    containerId,
    "psql",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    "noddle",
    "-c",
    // INCOMPRESSIBLE, and it took two tries to get there:
    // `repeat('x', 400)` went from 360 MB to 3.8 MB, then
    // `repeat(md5(...), 10)` repeated the SAME md5 ten times per row, so it
    // still compressed. DISTINCT concatenated md5s do not compress.
    // Without that the dump finished before the kill and the test reported a
    // defect that did not exist.
    "CREATE TABLE gros AS SELECT g, md5(random()::text) || md5(random()::text) || md5(random()::text) || md5(random()::text) AS bourrage FROM generate_series(1, 600000) g",
  ]);
  ok("large incompressible table created");

  const keyKo = backupObjectKey({
    backupId: "interrompu",
    databaseName: NAME,
    extension: "dump",
    prefix: "sauvegardes",
    takenAt: new Date(),
  });
  const [broken] = await db
    .insert(backups)
    .values({ databaseId: database.id, objectKey: keyKo })
    .returning();
  if (!broken) {
    throw new Error("backup insert failed");
  }

  // 900 ms: the full dump is measured at ~2 s stably on this VM, so the cut
  // lands squarely inside. Killing later amounted to testing an already-finished
  // dump.
  const killer = (async () => {
    await new Promise((r) => setTimeout(r, 900));
    const k = await connect({
      host: TARGET.host,
      privateKey,
      user: TARGET.user,
    });
    try {
      await execArgv(k, ["docker", "kill", containerId]);
    } finally {
      disconnect(k);
    }
  })();

  let threw = false;
  try {
    await runBackup(ctx, broken.id);
  } catch {
    threw = true;
  }
  await killer;

  const brokenRow = await db.query.backups.findFirst({
    where: eq(backups.id, broken.id),
  });
  if (threw && brokenRow?.status === "failed") {
    ok(`interrupted dump: status ${brokenRow.status}, job in error`);
  } else {
    ko(`interrupted dump mishandled: threw=${threw} status=${brokenRow?.status}`);
  }
  if (await objectExists(destination, keyKo)) {
    ko("DANGER: the half-dump remained in the bucket");
  } else {
    ok("the incomplete object was removed from the bucket");
  }
  if (brokenRow?.errorMessage) {
    ok(`cause recorded: ${brokenRow.errorMessage.slice(0, 80)}…`);
  } else {
    ko("no cause recorded for the failed backup");
  }
} catch (error) {
  ko(`exception: ${error instanceof Error ? error.message : String(error)}`);
  if (error instanceof Error && error.stack) {
    console.log(error.stack.split("\n").slice(1, 5).join("\n"));
  }
} finally {
  if (ssh) {
    await removeService(dockerClient(ssh), legacyDatabaseServiceName(NAME)).catch(() => {
      // nothing to do: cleanup must not mask a real failure
    });
    disconnect(ssh);
  }
}

console.log(`\n\u001B[1mpassed ${pass}, failed ${fail}\u001B[0m\n`);
process.exit(fail === 0 ? 0 : 1);
