// tier: vm
// Volume restore, against REAL infrastructure.
//
//   node apps/worker/src/verify/verify-volume-restore.ts
//
// Same question as verify-restore: is the data from before back, and is
// the data from after gone? Markers live in a Docker volume, not a database.
import { randomBytes } from "node:crypto";

import { buildVolumeBackupInsert } from "@noddle/backup";
import { deleteObject } from "@noddle/backup-store";
import type { BackupDestination } from "@noddle/backup-store";
import { encryptSecret, secretContext } from "@noddle/crypto";
import { createDatabase } from "@noddle/db";
import {
  environments,
  projects,
  s3Destinations,
  servers,
  services,
  volumeBackups,
} from "@noddle/db/schema";
import { swarmServiceName } from "@noddle/shared/swarm-names";
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

import { seedSshKey, verifyCtx } from "#verify-seed";
import { runVolumeBackup } from "#volume-backup";
import { runVolumeRestore } from "#volume-restore";

const DB_URL = devStack().databaseUrl;
const TARGET = devTarget();

const S3_ENDPOINT = devStack().s3.endpoint;
const S3_KEY = devStack().s3.accessKeyId;
const S3_SECRET = devStack().s3.secretAccessKey;
const S3_BUCKET = devStack().s3.bucket;

const SERVICE_NAME = "probe-vol-restore";
const VOLUME_NAME = "noddle-vol-restore-probe";

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
const { privateKey } = TARGET;
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
await db.delete(servers).where(inArray(servers.host, [TARGET.host]));

console.log(
  `\n\u001B[1mVolume restore — VM ${TARGET.host}, S3 ${S3_ENDPOINT}\u001B[0m`
);

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
      host: TARGET.host,
      name: "volume-restore-probe",
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

  ssh = await connect({ host: TARGET.host, privateKey, user: TARGET.user });
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
} catch (error) {
  ko(`exception: ${error instanceof Error ? error.message : String(error)}`);
  if (error instanceof Error && error.stack) {
    console.log(error.stack.split("\n").slice(1, 5).join("\n"));
  }
} finally {
  if (ssh && swarmNameForCleanup) {
    const docker = dockerClient(ssh);
    await removeService(docker, swarmNameForCleanup).catch(() => {
      /* empty */
    });
    await execArgv(ssh, ["docker", "volume", "rm", "-f", VOLUME_NAME]).catch(
      () => {
        /* empty */
      }
    );
    disconnect(ssh);
  }
}

console.log(`\n\u001B[1mpassed ${pass}, failed ${fail}\u001B[0m\n`);
process.exit(fail === 0 ? 0 : 1);
