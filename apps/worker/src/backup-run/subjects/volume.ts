import { buildVolumeBackupInsert } from "@noddle/backup";
import { parseVolumeNameFromObjectKey } from "@noddle/backup-store";
import { volumeBackupConfigs, volumeBackups } from "@noddle/db/schema";
import type { servers } from "@noddle/db/schema";
import { exec, execStream, quoteArg } from "@noddle/ssh-executor";
import type { SshClient } from "@noddle/ssh-executor";
import { and, desc, eq, inArray } from "drizzle-orm";

import { captureToS3 } from "#backup-run/pipeline";
import type { BackupRunRow, BackupSubject } from "#backup-run/pipeline";
import type { BackupRecoverSubject } from "#backup-run/recover";
import { pruneBackupRuns, sweepBackupConfigs } from "#backup-run/sweep";
import type { BackupPruneSubject, BackupSweepSubject } from "#backup-run/sweep";
import type { DeployContext } from "#runtime-context";

const SAFE_VOLUME_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

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
    async () => {}
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

interface VolumeBackupRun extends BackupRunRow {
  config?: { destinationId: string; volumeName: string } | null;
  service: {
    id: string;
    name: string;
    server: typeof servers.$inferSelect;
  };
  serviceId: string;
  volumeName: string;
}

export const volumeBackupSubject: BackupSubject<VolumeBackupRun> = {
  capture: async (_ctx, client, run, destination) => {
    const volumeName = resolveVolumeName(run);
    await ensureAlpineImage(client);
    await ensureVolumeExists(client, volumeName);
    const command = tarBackupCommand(volumeName);
    return await captureToS3(client, command, destination, run.objectKey);
  },
  incompleteMessage: (code, stderr) =>
    `volume tar exited with ${code} — backup incomplete, object deleted: ${stderr.slice(0, 500)}`,
  loadRun: async (ctx, runId) => {
    const backup = await ctx.db.query.volumeBackups.findFirst({
      where: eq(volumeBackups.id, runId),
      with: {
        config: true,
        service: { with: { server: true } },
      },
    });
    if (!backup) {
      return null;
    }
    return {
      ...backup,
      configDestinationId: backup.config?.destinationId ?? null,
    };
  },
  markCompleted: async (ctx, runId, sizeBytes) => {
    await ctx.db
      .update(volumeBackups)
      .set({ finishedAt: new Date(), sizeBytes, status: "completed" })
      .where(eq(volumeBackups.id, runId));
  },
  markFailed: async (ctx, runId, message) => {
    await ctx.db
      .update(volumeBackups)
      .set({
        errorMessage: message,
        finishedAt: new Date(),
        status: "failed",
      })
      .where(eq(volumeBackups.id, runId));
  },
  markRunning: async (ctx, runId, destinationId) => {
    await ctx.db
      .update(volumeBackups)
      .set({ destinationId, startedAt: new Date(), status: "running" })
      .where(eq(volumeBackups.id, runId));
  },
  notFoundMessage: (runId) => `volume backup not found: ${runId}`,
  notifyResource: (run) => run.service.name,
  prune: async (ctx, run) => {
    await pruneVolumeBackups(ctx, {
      configId: run.configId,
      serviceId: run.serviceId,
    });
  },
  server: (run) => run.service.server,
};

type VolumeConfig = typeof volumeBackupConfigs.$inferSelect & {
  service: { id: string; name: string; status: string };
};

export const volumeSweepSubject: BackupSweepSubject<VolumeConfig> = {
  configDestinationId: (config) => config.destinationId,
  configId: (config) => config.id,
  configSchedule: (config) => config.schedule,
  findInFlight: async (ctx, configId) => {
    const row = await ctx.db.query.volumeBackups.findFirst({
      where: and(
        eq(volumeBackups.configId, configId),
        inArray(volumeBackups.status, ["queued", "running"])
      ),
    });
    return row !== undefined;
  },
  findLastCompletedAt: async (ctx, configId) => {
    const last = await ctx.db.query.volumeBackups.findFirst({
      orderBy: desc(volumeBackups.createdAt),
      where: and(
        eq(volumeBackups.configId, configId),
        eq(volumeBackups.status, "completed")
      ),
    });
    return last?.createdAt ?? null;
  },
  insertScheduled: async (ctx, config, resolved) => {
    const [created] = await ctx.db
      .insert(volumeBackups)
      .values(
        buildVolumeBackupInsert({
          configId: config.id,
          configPrefix: config.prefix,
          kind: "scheduled",
          resolved,
          service: config.service,
          volumeName: config.volumeName,
        })
      )
      .returning();
    return created ?? null;
  },
  isParentActive: (config) => config.service.status === "running",
  loadEnabledConfigs: async (ctx) =>
    await ctx.db.query.volumeBackupConfigs.findMany({
      where: eq(volumeBackupConfigs.enabled, true),
      with: { service: true },
    }),
};

export const volumePruneSubject: BackupPruneSubject = {
  deleteRun: async (ctx, runId) => {
    await ctx.db.delete(volumeBackups).where(eq(volumeBackups.id, runId));
  },
  findExcessRuns: async (ctx, configId, keepLatestCount) => {
    const kept = await ctx.db.query.volumeBackups.findMany({
      orderBy: desc(volumeBackups.createdAt),
      where: and(
        eq(volumeBackups.configId, configId),
        eq(volumeBackups.status, "completed")
      ),
    });
    return kept.slice(keepLatestCount);
  },
  loadKeepLatestCount: async (ctx, configId) => {
    const config = await ctx.db.query.volumeBackupConfigs.findFirst({
      where: eq(volumeBackupConfigs.id, configId),
    });
    return config?.keepLatestCount;
  },
};

export const volumeRecoverSubject: BackupRecoverSubject = {
  findRunningIds: async (ctx) => {
    const running = await ctx.db.query.volumeBackups.findMany({
      where: eq(volumeBackups.status, "running"),
    });
    return running.map((row) => row.id);
  },
  markStaleFailed: async (ctx, ids, message) => {
    await ctx.db
      .update(volumeBackups)
      .set({
        errorMessage: message,
        finishedAt: new Date(),
        status: "failed",
      })
      .where(inArray(volumeBackups.id, ids));
  },
};

export async function sweepVolumeBackupConfigs(
  ctx: DeployContext,
  enqueue: (volumeBackupId: string) => Promise<unknown>
) {
  return await sweepBackupConfigs(volumeSweepSubject, ctx, enqueue);
}

export async function pruneVolumeBackups(
  ctx: DeployContext,
  opts: { configId: string | null; serviceId: string }
) {
  return await pruneBackupRuns(volumePruneSubject, ctx, opts);
}

export async function recoverStaleVolumeBackups(
  ctx: DeployContext
): Promise<number> {
  const { recoverStaleBackupRuns } = await import("#backup-run/recover");
  return await recoverStaleBackupRuns(volumeRecoverSubject, ctx);
}
