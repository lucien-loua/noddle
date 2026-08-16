// tier: vm
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveDestination } from "@noddle/backup";
import { checkDestination, objectExists } from "@noddle/backup-store";
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
import {
  connect,
  disconnect,
  dockerClient,
  execArgv,
} from "@noddle/ssh-executor";
import { removeService } from "@noddle/swarm-ops";
import { devStack } from "@noddle/testing/dev-stack";
import { eq, inArray } from "drizzle-orm";
import { runBackup } from "#backup";
import { provisionDatabase } from "#database";
import { legacyDatabaseServiceName } from "#database-runtime";
import { seedSshKey, verifyCtx } from "#verify-seed";

const DB_URL = devStack().databaseUrl;
const HOST = process.env.STACK_HOST ?? "192.168.252.3";
const USER = process.env.TARGET_USER ?? "ubuntu";
const KEY = process.env.SSH_KEY ?? join(homedir(), ".ssh", "id_ed25519");

const S3_ENDPOINT = devStack().s3.endpoint;
const S3_KEY = devStack().s3.accessKeyId;
const S3_SECRET = devStack().s3.secretAccessKey;
const S3_BUCKET = devStack().s3.bucket;

const NAME = "probe-multi-dest";
/** Two DISTINCT prefixes in the same bucket: the only detail that makes
 *  "where did it go" observable from storage. */
const PREFIX_A = "dest-a";
const PREFIX_B = "dest-b";

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
  "verify-multi-destination",
  privateKey
);

let ssh: Awaited<ReturnType<typeof connect>> | undefined;

await db.delete(backups);
await db.delete(s3Destinations);
await db.delete(databases);
await db.delete(environments);
await db.delete(projects);
await db.delete(servers).where(inArray(servers.host, [HOST]));

console.log(
  `\n\x1b[1mMultiple destinations — VM ${HOST}, S3 ${S3_ENDPOINT}\x1b[0m`
);

async function makeDestination(name: string, prefix: string) {
  const [row] = await db
    .insert(s3Destinations)
    .values({
      accessKeyId: S3_KEY,
      bucket: S3_BUCKET,
      endpoint: S3_ENDPOINT,
      name,
      prefix,
      region: "us-east-1",
      secretAccessKeyEncrypted: "placeholder",
    })
    .returning();
  if (!row) {
    throw new Error(`destination ${name} insert failed`);
  }
  await db
    .update(s3Destinations)
    .set({
      secretAccessKeyEncrypted: encryptSecret(
        S3_SECRET,
        appKey,
        secretContext.backupDestination(row.id)
      ),
    })
    .where(eq(s3Destinations.id, row.id));
  return row;
}

try {
  const [server] = await db
    .insert(servers)
    .values({
      host: HOST,
      name: "multi-dest-manager",
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

  const destA = await makeDestination("Destination A", PREFIX_A);
  const destB = await makeDestination("Destination B", PREFIX_B);
  ok("two destinations registered, each with its prefix");

  await checkDestination({
    accessKeyId: S3_KEY,
    bucket: S3_BUCKET,
    endpoint: S3_ENDPOINT,
    forcePathStyle: true,
    prefix: PREFIX_B,
    region: "us-east-1",
    secretAccessKey: S3_SECRET,
  });
  ok(`bucket "${S3_BUCKET}" reachable for writes`);

  const ctx = verifyCtx({ appKey, db });
  const route = { networkName: "noddle-public" };

  // ── The refusal: two destinations, no choice ────────────────────────────
  //
  // The assertion that gives meaning to all the others. Without it, "the
  // backup went to B" would not distinguish a respected choice from a
  // resolver that picks the last one at random.
  try {
    await resolveDestination(db, appKey, null);
    ko("no choice + two destinations: accepted when it must refuse");
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (message.includes("several S3 destinations")) {
      ok("no choice + two destinations: refused explicitly");
    } else {
      ko(`refused, but for the wrong reason: ${message}`);
    }
  }

  // And the SYMMETRIC case: an explicit choice passes. Without it, a
  // resolver that refused ALWAYS would pass the test above.
  const chosen = await resolveDestination(db, appKey, destB.id);
  if (chosen.id === destB.id && chosen.destination.prefix === PREFIX_B) {
    ok("an explicit choice returns THIS destination");
  } else {
    ko(`explicit choice: returned ${chosen.id} / ${chosen.destination.prefix}`);
  }

  // ── A real database, aimed at the SECOND destination ────────────────────
  ssh = await connect({ host: HOST, privateKey, user: USER });
  await removeService(dockerClient(ssh), legacyDatabaseServiceName(NAME));
  await execArgv(ssh, [
    "sh",
    "-c",
    `for i in $(seq 1 20); do docker volume rm ${legacyDatabaseServiceName(NAME)} >/dev/null 2>&1 && exit 0; sleep 1; done; exit 0`,
  ]);

  const [proj] = await db
    .insert(projects)
    .values({ name: "multi-dest-probe" })
    .returning();
  const [env] = await db
    .insert(environments)
    .values({ name: "production", projectId: proj?.id ?? "" })
    .returning();

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

  await provisionDatabase(ctx, route, database.id);
  ok("Postgres database provisioned on the VM");

  const [row] = await db
    .insert(backups)
    .values({
      databaseId: database.id,
      // Explicit destination: the row decides the bucket, not a DB-level
      // preference (removed in favor of backup_configs).
      destinationId: destB.id,
      kind: "manual",
      objectKey: `${PREFIX_B}/probe-${crypto.randomUUID()}.dump`,
    })
    .returning();
  if (!row) {
    throw new Error("backup insert failed");
  }

  await runBackup(ctx, row.id);

  const done = await db.query.backups.findFirst({
    where: eq(backups.id, row.id),
  });
  if (done?.status === "completed") {
    ok("the backup completed");
  } else {
    ko(`backup: status ${done?.status} — ${done?.errorMessage}`);
  }

  // 1. Does the DB say where it went?
  if (done?.destinationId === destB.id) {
    ok("`backups.destination_id` points at the chosen destination (B)");
  } else {
    ko(`destination_id = ${done?.destinationId}, expected ${destB.id}`);
  }

  // 2. Does the BUCKET confirm it? The DB could lie.
  const inB = await objectExists(
    {
      accessKeyId: S3_KEY,
      bucket: S3_BUCKET,
      endpoint: S3_ENDPOINT,
      forcePathStyle: true,
      prefix: PREFIX_B,
      region: "us-east-1",
      secretAccessKey: S3_SECRET,
    },
    done?.objectKey ?? ""
  );
  if (inB) {
    ok("the object is REALLY under B's prefix, not only in the DB");
  } else {
    ko(`object absent from the bucket: ${done?.objectKey}`);
  }

  // 3. And it did not end up under A. `objectExists` takes an absolute key,
  //    so it is the prefix IN the key that decides: a key starting with
  //    `dest-a/` would mean the resolver took A.
  if (done?.objectKey.startsWith(`${PREFIX_B}/`)) {
    ok(`object key carries B's prefix ("${PREFIX_B}/…")`);
  } else {
    ko(`unexpected key: ${done?.objectKey}`);
  }

  // 4. A destination that no longer exists must be STATED, not guessed.
  await db.delete(s3Destinations).where(eq(s3Destinations.id, destA.id));
  try {
    await resolveDestination(db, appKey, destA.id);
    ko("a deleted destination is accepted");
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (message.includes("no longer exists")) {
      ok("a deleted destination is refused with a clear message");
    } else {
      ko(`refused, but for the wrong reason: ${message}`);
    }
  }
} catch (e) {
  ko(`exception: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  if (ssh) {
    try {
      await removeService(dockerClient(ssh), legacyDatabaseServiceName(NAME));
      await execArgv(ssh, [
        "sh",
        "-c",
        `for i in $(seq 1 20); do docker volume rm ${legacyDatabaseServiceName(NAME)} >/dev/null 2>&1 && exit 0; sleep 1; done; exit 0`,
      ]);
    } catch {
      // best-effort cleanup
    }
    disconnect(ssh);
  }
}

console.log(`\n\x1b[1mpassed ${pass}, failed ${fail}\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
