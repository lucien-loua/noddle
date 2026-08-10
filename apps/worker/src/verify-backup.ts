// STACK_HOST=192.168.252.3 node apps/worker/src/verify-backup.ts
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type BackupDestination,
  backupObjectKey,
  checkDestination,
  objectExists,
} from "@noddle/backup-store";
import { createDatabase } from "@noddle/db";
import {
  backups,
  databases,
  environments,
  projects,
  s3Destinations,
  servers,
} from "@noddle/db/schema";
import { encryptSecret, secretContext } from "@noddle/shared/crypto";
import {
  connect,
  disconnect,
  dockerClient,
  execArgv,
} from "@noddle/ssh-executor";
import { eq, inArray } from "drizzle-orm";
import {
  findDatabaseContainer,
  legacyDatabaseServiceName,
  runBackup,
} from "#backup";
import { provisionDatabase } from "#database";
import { removeService } from "#swarm";
import { seedSshKey } from "#verify-seed";

const DB_URL =
  process.env.DATABASE_URL ??
  "postgres://postgres:noddle@localhost:55432/noddle";
const HOST = process.env.STACK_HOST ?? "192.168.252.3";
const USER = process.env.TARGET_USER ?? "ubuntu";
const KEY = process.env.SSH_KEY ?? join(homedir(), ".ssh", "id_ed25519");

// RustFS runs on the dev machine; the VM must be able to reach it, so
// it is the worker (here) that talks to S3, never the target — which is
// exactly the topology we settled on.
const S3_ENDPOINT = process.env.S3_ENDPOINT ?? "http://localhost:9000";
const S3_KEY = process.env.S3_ACCESS_KEY ?? "rustfsadmin";
const S3_SECRET = process.env.S3_SECRET_KEY ?? "rustfsadmin";
const S3_BUCKET = process.env.S3_BUCKET ?? "noddle-verify";

const NAME = "probe-sauvegarde";

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

/**
 * Setup command that MUST succeed.
 *
 * `execArgv` returns an exit code that nothing required us to read: a
 * `CREATE TABLE` failing on an already-present table went unnoticed, and the
 * test then measured a tiny dump while believing it was measuring a large one.
 * A harness that ignores its own setup failures reports results that do not
 * cover what it claims.
 */
async function must(
  client: Awaited<ReturnType<typeof connect>>,
  argv: string[]
): Promise<string> {
  const r = await execArgv(client, argv);
  if (r.code !== 0) {
    throw new Error(
      `setup failed (code ${r.code}): ${argv.slice(0, 4).join(" ")} — ${r.stderr.slice(0, 300)}`
    );
  }
  return r.stdout;
}

const appKey = randomBytes(32);
const db = createDatabase({ url: DB_URL });
const privateKey = readFileSync(KEY, "utf8");
const sshKeyId = await seedSshKey(db, appKey, "verify-backup", privateKey);

let ssh: Awaited<ReturnType<typeof connect>> | undefined;

await db.delete(backups);
await db.delete(s3Destinations);
await db.delete(databases);
await db.delete(environments);
await db.delete(projects);
await db.delete(servers).where(inArray(servers.host, [HOST]));

console.log(`\n\x1b[1mBackups — VM ${HOST}, S3 ${S3_ENDPOINT}\x1b[0m`);

try {
  const [server] = await db
    .insert(servers)
    .values({
      host: HOST,
      name: "sauvegarde-probe-manager",
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
        secretContext.backupDestination(dest.id)
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

  const ctx = {
    appKey,
    db,
    logRoot: "/tmp/noddle-backup-logs",
    networkName: "noddle-public",
  };

  ssh = await connect({ host: HOST, privateKey, user: USER });
  await removeService(dockerClient(ssh), legacyDatabaseServiceName(NAME));
  // The volume does NOT disappear with the service — that is the whole point
  // of a named volume. Without this purge, each run inherits the previous
  // run's tables and therefore does not start from the state it claims.
  await execArgv(ssh, [
    "sh",
    "-c",
    `for i in $(seq 1 20); do docker volume rm ${legacyDatabaseServiceName(NAME)} >/dev/null 2>&1 && exit 0; sleep 1; done; exit 0`,
  ]);

  const [proj] = await db
    .insert(projects)
    .values({ name: "sauvegarde-probe" })
    .returning();
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
        secretContext.databasePassword(database.id)
      ),
    })
    .where(eq(databases.id, database.id));

  await provisionDatabase(ctx, database.id);
  ok("Postgres database provisioned on the VM");

  const containerId = await findDatabaseContainer(
    ssh,
    legacyDatabaseServiceName(NAME)
  );
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
    const k = await connect({ host: HOST, privateKey, user: USER });
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
    ko(
      `interrupted dump mishandled: threw=${threw} status=${brokenRow?.status}`
    );
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
      // nothing to do: cleanup must not mask a real failure
    });
    disconnect(ssh);
  }
}

console.log(`\n\x1b[1mpassed ${pass}, failed ${fail}\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
