import type { Readable } from "node:stream";
import { resolveDestination } from "@noddle/backup";
import {
  type BackupDestination,
  deleteObject,
  objectExists,
  objectSize,
  parseVolumeNameFromObjectKey,
  uploadStream,
} from "@noddle/backup-store";
import { volumeBackups } from "@noddle/db/schema";
import {
  exec,
  execStream,
  quoteArg,
  type SshClient,
} from "@noddle/ssh-executor";
import { eq } from "drizzle-orm";
import { notify } from "#notify";
import { connectTo, type DeployContext } from "#runtime-context";

const SAFE_VOLUME_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

/** Pinned image for volume tar/restore helpers — pulled explicitly before use. */
export const ALPINE_IMAGE = "alpine:3";

export function assertSafeVolumeName(value: string): void {
  if (!SAFE_VOLUME_NAME.test(value)) {
    throw new Error(
      `volume name is not safe for shell use: "${value}" — letters, digits, underscore, dot and hyphen only`
    );
  }
}

export function resolveVolumeName(backup: {
  config?: { volumeName: string } | null;
  objectKey: string;
  volumeName: string;
}): string {
  const name =
    backup.volumeName ||
    backup.config?.volumeName ||
    parseVolumeNameFromObjectKey(backup.objectKey);
  if (!name) {
    throw new Error(
      "volume name is missing on this backup row — cannot resolve Docker volume"
    );
  }
  return name;
}

export async function ensureAlpineImage(client: SshClient): Promise<void> {
  const inspect = await exec(
    client,
    `docker image inspect ${quoteArg(ALPINE_IMAGE)}`
  );
  if (inspect.code === 0) {
    return;
  }
  const pull = await exec(client, `docker pull ${quoteArg(ALPINE_IMAGE)}`);
  if (pull.code !== 0) {
    throw new Error(
      `could not pull ${ALPINE_IMAGE} on this server: ${pull.stderr.slice(0, 500)}`
    );
  }
}

async function ensureVolumeExists(
  client: SshClient,
  volumeName: string
): Promise<void> {
  const { code, stderr } = await execStream(
    client,
    `docker volume inspect ${quoteArg(volumeName)}`,
    async () => undefined
  );
  if (code !== 0) {
    throw new Error(
      `docker volume ${volumeName} not found on this server: ${stderr.slice(0, 300)}`
    );
  }
}

function tarBackupCommand(volumeName: string): string {
  assertSafeVolumeName(volumeName);
  return [
    "docker",
    "run",
    "--rm",
    "--pull=never",
    "-v",
    `${volumeName}:/data:ro`,
    ALPINE_IMAGE,
    "tar",
    "czf",
    "-",
    "-C",
    "/data",
    ".",
  ]
    .map(quoteArg)
    .join(" ");
}

async function uploadedSize(
  destination: BackupDestination,
  key: string
): Promise<number> {
  if (!(await objectExists(destination, key))) {
    throw new Error(
      `the upload finished but object ${key} is missing from the bucket`
    );
  }
  return await objectSize(destination, key);
}

export async function runVolumeBackup(
  ctx: DeployContext,
  volumeBackupId: string
): Promise<void> {
  const backup = await ctx.db.query.volumeBackups.findFirst({
    where: eq(volumeBackups.id, volumeBackupId),
    with: {
      config: true,
      service: { with: { server: true } },
    },
  });
  if (!backup) {
    throw new Error(`volume backup not found: ${volumeBackupId}`);
  }

  const volumeName = resolveVolumeName(backup);

  const { destination, id: destinationId } = await resolveDestination(
    ctx.db,
    ctx.appKey,
    backup.destinationId ?? backup.config?.destinationId ?? null
  );

  await ctx.db
    .update(volumeBackups)
    .set({ destinationId, startedAt: new Date(), status: "running" })
    .where(eq(volumeBackups.id, volumeBackupId));

  const client = await connectTo(ctx, backup.service.server);

  try {
    await ensureAlpineImage(client);
    await ensureVolumeExists(client, volumeName);
    const command = tarBackupCommand(volumeName);
    const { code, stderr } = await execStream(client, command, (io) =>
      uploadStream(destination, backup.objectKey, io.stdout as Readable)
    );

    if (code !== 0) {
      await deleteObject(destination, backup.objectKey).catch(() => undefined);
      throw new Error(
        `volume tar exited with ${code} — backup incomplete, object deleted: ${stderr.slice(0, 500)}`
      );
    }

    const sizeBytes = await uploadedSize(destination, backup.objectKey);

    await ctx.db
      .update(volumeBackups)
      .set({ finishedAt: new Date(), sizeBytes, status: "completed" })
      .where(eq(volumeBackups.id, volumeBackupId));

    try {
      const { pruneVolumeBackups } = await import("#volume-backup-sweep");
      await pruneVolumeBackups(ctx, {
        configId: backup.configId,
        serviceId: backup.serviceId,
      });
    } catch {
      // Retention can retry on the next successful run.
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await ctx.db
      .update(volumeBackups)
      .set({
        errorMessage: message,
        finishedAt: new Date(),
        status: "failed",
      })
      .where(eq(volumeBackups.id, volumeBackupId));
    await notify(ctx, {
      detail: message,
      resource: backup.service.name,
      type: "backup_failed",
    });
    throw err;
  } finally {
    const { disconnect } = await import("@noddle/ssh-executor");
    disconnect(client);
  }
}
