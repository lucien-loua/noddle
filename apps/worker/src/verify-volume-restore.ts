// Volume restore, against REAL infrastructure.
//
//   STACK_HOST=192.168.252.3 node apps/worker/src/verify-volume-restore.ts
//
// Same question as verify-restore: is the data from before back, and is
// the data from after gone? Markers live in a Docker volume, not a database.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildVolumeBackupInsert } from "@noddle/backup";
import { type BackupDestination, deleteObject } from "@noddle/backup-store";
import { createDatabase } from "@noddle/db";
import {
  environments,
  projects,
  s3Destinations,
  servers,
  services,
  volumeBackups,
} from "@noddle/db/schema";
import { encryptSecret, secretContext } from "@noddle/crypto";
import { swarmServiceName } from "@noddle/shared/swarm-names";
import {
  connect,
  disconnect,
  dockerClient,
  execArgv,
} from "@noddle/ssh-executor";
import { removeService } from "@noddle/swarm-ops";
import { eq, inArray } from "drizzle-orm";
import { seedSshKey, verifyCtx } from "#verify-seed";
import { runVolumeBackup } from "#volume-backup";
import { runVolumeRestore } from "#volume-restore";

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

const SERVICE_NAME = "probe-vol-restore";
const VOLUME_NAME = "noddle-vol-restore-probe";

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

async function readMarker(
  client: Awaited<ReturnType<typeof connect>>
): Promise<string> {
  return (
    await must(client, [
      "docker",
      "run",
      "--rm",
      "-v",
      `${VOLUME_NAME}:/data`,
      "alpine:3",
      "cat",
      "/data/marker",
    ])
  ).trim();
}

async function writeMarker(
  client: Awaited<ReturnType<typeof connect>>,
  value: string
): Promise<void> {
  await must(client, [
    "docker",
    "run",
    "--rm",
    "-v",
    `${VOLUME_NAME}:/data`,
    "alpine:3",
    "sh",
    "-c",
    `printf '%s' '${value}' > /data/marker`,
  ]);
}

const appKey = randomBytes(32);
const db = createDatabase({ url: DB_URL });
const privateKey = readFileSync(KEY, "utf8");
const sshKeyId = await seedSshKey(
  db,
  appKey,
  "verify-volume-restore",
  privateKey
);

let ssh: Awaited<ReturnType<typeof connect>> | undefined;
let swarmNameForCleanup: string | undefined;

await db.delete(volumeBackups);
await db.delete(s3Destinations);
await db.delete(services);
await db.delete(environments);
await db.delete(projects);
await db.delete(servers).where(inArray(servers.host, [HOST]));

console.log(`\n\x1b[1mVolume restore — VM ${HOST}, S3 ${S3_ENDPOINT}\x1b[0m`);

const destination: BackupDestination = {
  accessKeyId: S3_KEY,
  bucket: S3_BUCKET,
  endpoint: S3_ENDPOINT,
  forcePathStyle: true,
  prefix: "volume-restore",
  region: "us-east-1",
  secretAccessKey: S3_SECRET,
};

try {
  const [server] = await db
    .insert(servers)
    .values({
      host: HOST,
      name: "volume-restore-probe",
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
      prefix: "volume-restore",
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

  ssh = await connect({ host: HOST, privateKey, user: USER });
  const docker = dockerClient(ssh);

  const [proj] = await db
    .insert(projects)
    .values({ name: "volume-restore-probe" })
    .returning();
  const [env] = await db
    .insert(environments)
    .values({ name: "production", projectId: proj?.id ?? "" })
    .returning();
  const [svc] = await db
    .insert(services)
    .values({
      environmentId: env?.id ?? "",
      name: SERVICE_NAME,
      serverId: server.id,
      sourceType: "git",
      status: "running",
    })
    .returning();
  if (!svc) {
    throw new Error("service insertion failed");
  }
  swarmNameForCleanup = swarmServiceName(svc);

  await removeService(docker, swarmNameForCleanup);
  await execArgv(ssh, ["docker", "volume", "rm", "-f", VOLUME_NAME]);

  await must(ssh, ["docker", "volume", "create", VOLUME_NAME]);
  await writeMarker(ssh, "avant");
  ok("volume created with marker 'avant'");

  await must(ssh, [
    "docker",
    "service",
    "create",
    "--name",
    swarmNameForCleanup,
    "--mount",
    `type=volume,source=${VOLUME_NAME},target=/data`,
    "alpine:3",
    "sleep",
    "infinity",
  ]);
  ok(`Swarm service ${swarmNameForCleanup} created with volume mount`);

  const insertValues = buildVolumeBackupInsert({
    kind: "manual",
    resolved: { id: dest.id, prefix: dest.prefix },
    service: svc,
    volumeName: VOLUME_NAME,
  });
  const [backupRow] = await db
    .insert(volumeBackups)
    .values({
      ...insertValues,
      destinationId: dest.id,
    })
    .returning();
  if (!backupRow) {
    throw new Error("volume backup row insertion failed");
  }
  await runVolumeBackup(ctx, backupRow.id);
  ok(`volume backup taken (${backupRow.objectKey.split("/").pop()})`);

  await writeMarker(ssh, "apres");
  const before = await readMarker(ssh);
  if (before === "apres") {
    ok("state before restore: marker is 'apres'");
  } else {
    ko(`unexpected marker before restore: ${before}`);
  }

  await runVolumeRestore(ctx, {
    backupId: backupRow.id,
    serviceId: svc.id,
  });

  const after = await readMarker(ssh);
  if (after === "avant") {
    ok("volume restored: marker is 'avant' again");
  } else {
    ko(`volume poorly restored: marker is '${after}'`);
  }

  const orphan = buildVolumeBackupInsert({
    kind: "manual",
    resolved: { id: dest.id, prefix: dest.prefix },
    service: svc,
    volumeName: VOLUME_NAME,
  });
  const [orphanRow] = await db
    .insert(volumeBackups)
    .values({
      ...orphan,
      destinationId: dest.id,
      status: "completed",
    })
    .returning();
  if (!orphanRow) {
    throw new Error("orphan backup row insertion failed");
  }
  await deleteObject(destination, orphanRow.objectKey);
  try {
    await runVolumeRestore(ctx, {
      backupId: orphanRow.id,
      serviceId: svc.id,
    });
    ko("restore started even though the object is missing");
  } catch {
    ok("object missing from the bucket: refused BEFORE touching the volume");
  }
  const still = await readMarker(ssh);
  if (still === "avant") {
    ok("volume intact after refused restore");
  } else {
    ko(`volume damaged by refused restore: marker is '${still}'`);
  }
} catch (err) {
  ko(`exception: ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof Error && err.stack) {
    console.log(err.stack.split("\n").slice(1, 5).join("\n"));
  }
} finally {
  if (ssh && swarmNameForCleanup) {
    const docker = dockerClient(ssh);
    await removeService(docker, swarmNameForCleanup).catch(() => undefined);
    await execArgv(ssh, ["docker", "volume", "rm", "-f", VOLUME_NAME]).catch(
      () => undefined
    );
    disconnect(ssh);
  }
}

console.log(`\n\x1b[1mpassed ${pass}, failed ${fail}\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
