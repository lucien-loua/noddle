import { pipeline } from "node:stream/promises";

import { buildVolumeBackupInsert, resolveDestinationRow } from "@noddle/backup";
import {
  services,
  volumeBackupConfigs,
  volumeBackups,
} from "@noddle/db/schema";
import type { servers } from "@noddle/db/schema";
import { scaleServiceAndWait } from "@noddle/deploy-engine/ops";
import { swarmServiceName } from "@noddle/shared/swarm-names";
import { disconnect, execStream, quoteArg } from "@noddle/ssh-executor";
import type { SshClient } from "@noddle/ssh-executor";
import { eq } from "drizzle-orm";

import { runRestorePipeline } from "#backup-run/restore-pipeline";
import type { RestoreSubject } from "#backup-run/restore-pipeline";
import {
  ALPINE_IMAGE,
  assertSafeVolumeName,
  ensureAlpineImage,
} from "#backup-run/subjects/volume";
import { withDeployClients } from "#job-run";
import type { DeployContext } from "#runtime-context";
import { runVolumeBackup } from "#volume-backup";

export interface VolumeRestoreRequest {
  backupId?: string;
  destinationId?: string;
  objectKey?: string;
  serviceId: string;
  volumeName?: string;
}

type ServiceRow = NonNullable<
  Awaited<ReturnType<DeployContext["db"]["query"]["services"]["findFirst"]>>
> & { server: typeof servers.$inferSelect };

type VolumeBackupRow = NonNullable<
  Awaited<
    ReturnType<DeployContext["db"]["query"]["volumeBackups"]["findFirst"]>
  >
> & {
  config?: Awaited<
    ReturnType<DeployContext["db"]["query"]["volumeBackupConfigs"]["findFirst"]>
  > | null;
};

interface VolumeRestoreLoaded {
  backupRow: VolumeBackupRow | null;
  objectKey: string;
  request: VolumeRestoreRequest;
  service: ServiceRow;
  targetVolume: string;
}

function tarRestoreCommand(volumeName: string): string {
  assertSafeVolumeName(volumeName);
  const script = "rm -rf /data/* /data/.[!.]* 2>/dev/null; tar xzf - -C /data";
  return [
    "docker",
    "run",
    "--rm",
    "--pull=never",
    "-i",
    "-v",
    `${volumeName}:/data`,
    ALPINE_IMAGE,
    "sh",
    "-c",
    script,
  ]
    .map(quoteArg)
    .join(" ");
}

async function restoreVolumeStream(
  client: SshClient,
  volumeName: string,
  body: NodeJS.ReadableStream
): Promise<void> {
  const command = tarRestoreCommand(volumeName);
  const { code, stderr } = await execStream(client, command, async (io) => {
    await pipeline(body, io.stdin);
  });
  if (code !== 0) {
    throw new Error(
      `volume restore tar failed (code ${code}): ${stderr.slice(0, 500)}`
    );
  }
}

async function applyVolumeRestore(
  ctx: DeployContext,
  loaded: VolumeRestoreLoaded,
  body: NodeJS.ReadableStream
): Promise<void> {
  const swarmName = swarmServiceName(loaded.service);

  await withDeployClients(
    ctx,
    loaded.service.server,
    async ({ managerDocker }) => {
      await scaleServiceAndWait(managerDocker, swarmName, 0);

      const client = await ctx.connectTo(loaded.service.server);
      try {
        await ensureAlpineImage(client);
        await restoreVolumeStream(client, loaded.targetVolume, body);
      } finally {
        disconnect(client);
      }

      await scaleServiceAndWait(managerDocker, swarmName, 1);
    }
  );
}

const volumeRestoreSubject: RestoreSubject<
  VolumeRestoreRequest,
  VolumeRestoreLoaded
> = {
  apply: applyVolumeRestore,
  load: async (ctx, request) => {
    const service = await ctx.db.query.services.findFirst({
      where: eq(services.id, request.serviceId),
      with: { server: true },
    });
    if (!service) {
      throw new Error(`service not found: ${request.serviceId}`);
    }

    const backupRow: VolumeBackupRow | null = request.backupId
      ? ((await ctx.db.query.volumeBackups.findFirst({
          where: eq(volumeBackups.id, request.backupId),
          with: { config: true },
        })) ?? null)
      : null;

    if (
      request.backupId &&
      (!backupRow || backupRow.serviceId !== service.id)
    ) {
      throw new Error("volume backup not found for this service");
    }
    if (backupRow && backupRow.status !== "completed") {
      throw new Error("only a completed volume backup can be restored");
    }

    const targetVolume =
      backupRow?.volumeName ??
      backupRow?.config?.volumeName ??
      request.volumeName ??
      "";
    if (!targetVolume) {
      throw new Error("cannot resolve target volume for restore");
    }

    const objectKey = backupRow?.objectKey ?? request.objectKey;
    if (!objectKey) {
      throw new Error("destination and object key are required for restore");
    }

    return { backupRow, objectKey, request, service, targetVolume };
  },
  missingObjectTarget: "volume",
  resolveSource: (_ctx, request, loaded) => {
    const destinationId =
      loaded.backupRow?.destinationId ??
      loaded.backupRow?.config?.destinationId ??
      request.destinationId ??
      null;
    if (!(loaded.objectKey && destinationId)) {
      throw new Error("destination and object key are required for restore");
    }
    return Promise.resolve({
      destinationId,
      objectKey: loaded.objectKey,
    });
  },
  safetyBackup: async (ctx, loaded) => {
    if (!loaded.backupRow?.configId) {
      return;
    }
    const configForPre = await ctx.db.query.volumeBackupConfigs.findFirst({
      where: eq(volumeBackupConfigs.id, loaded.backupRow.configId),
    });
    if (!configForPre) {
      return;
    }
    const resolved = await resolveDestinationRow(
      ctx.db,
      configForPre.destinationId
    );
    const [pre] = await ctx.db
      .insert(volumeBackups)
      .values(
        buildVolumeBackupInsert({
          configId: configForPre.id,
          configPrefix: configForPre.prefix,
          kind: "pre_restore",
          resolved,
          service: loaded.service,
          volumeName: loaded.targetVolume,
        })
      )
      .returning();
    if (pre) {
      await runVolumeBackup(ctx, pre.id);
    }
  },
};

export async function runVolumeRestore(
  ctx: DeployContext,
  request: VolumeRestoreRequest
): Promise<void> {
  await runRestorePipeline(volumeRestoreSubject, ctx, request);
}
