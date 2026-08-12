import { pipeline } from "node:stream/promises";
import {
  buildVolumeBackupInsert,
  resolveDestination,
  resolveDestinationRow,
} from "@noddle/backup";
import { downloadStream } from "@noddle/backup-store";
import {
  services,
  volumeBackupConfigs,
  volumeBackups,
} from "@noddle/db/schema";
import { swarmServiceName } from "@noddle/shared/swarm-names";
import type { DockerApi } from "@noddle/ssh-executor";
import {
  disconnect,
  execStream,
  quoteArg,
  type SshClient,
} from "@noddle/ssh-executor";
import { waitForRunningTask } from "@noddle/swarm-ops";
import { eq } from "drizzle-orm";
import { withDeployClients } from "#job-run";
import { connectTo, type DeployContext } from "#runtime-context";
import {
  ALPINE_IMAGE,
  assertSafeVolumeName,
  ensureAlpineImage,
  runVolumeBackup,
} from "#volume-backup";

const SCALE_TIMEOUT_MS = 120_000;

export interface VolumeRestoreRequest {
  backupId?: string;
  destinationId?: string;
  objectKey?: string;
  serviceId: string;
  volumeName?: string;
}

async function scaleServiceAndWait(
  docker: DockerApi,
  serviceName: string,
  replicas: number
): Promise<void> {
  const list = await docker.listServices({
    filters: JSON.stringify({ name: [serviceName] }),
  });
  const existing = list.find((s) => s.Spec?.Name === serviceName);
  if (!existing) {
    throw new Error(`Swarm service not found: ${serviceName}`);
  }

  const spec = existing.Spec as Record<string, unknown>;
  await docker.getService(existing.ID).update({
    ...spec,
    Mode: { Replicated: { Replicas: replicas } },
    version: existing.Version?.Index,
  });

  if (replicas === 0) {
    const deadline = Date.now() + SCALE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      // biome-ignore lint/performance/noAwaitInLoops: deliberate polling loop
      const tasks = await docker.listTasks({
        filters: JSON.stringify({ service: [serviceName] }),
      });
      const alive = tasks.filter((t: { Status?: { State?: string } }) => {
        const state = t.Status?.State;
        return (
          state !== "shutdown" && state !== "failed" && state !== "complete"
        );
      });
      if (alive.length === 0) {
        return;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(`service ${serviceName} did not scale down to 0 replicas`);
  }
  await waitForRunningTask(docker, serviceName);
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

export async function runVolumeRestore(
  ctx: DeployContext,
  request: VolumeRestoreRequest
): Promise<void> {
  const service = await ctx.db.query.services.findFirst({
    where: eq(services.id, request.serviceId),
    with: { server: true },
  });
  if (!service) {
    throw new Error(`service not found: ${request.serviceId}`);
  }

  const backupRow = request.backupId
    ? await ctx.db.query.volumeBackups.findFirst({
        where: eq(volumeBackups.id, request.backupId),
        with: { config: true },
      })
    : null;

  if (request.backupId && (!backupRow || backupRow.serviceId !== service.id)) {
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
  const destinationId =
    backupRow?.destinationId ??
    backupRow?.config?.destinationId ??
    request.destinationId;
  if (!(objectKey && destinationId)) {
    throw new Error("destination and object key are required for restore");
  }

  if (backupRow?.configId) {
    const configForPre = await ctx.db.query.volumeBackupConfigs.findFirst({
      where: eq(volumeBackupConfigs.id, backupRow.configId),
    });
    if (configForPre) {
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
            service,
            volumeName: targetVolume,
          })
        )
        .returning();
      if (pre) {
        await runVolumeBackup(ctx, pre.id);
      }
    }
  }

  const { destination } = await resolveDestination(
    ctx.db,
    ctx.appKey,
    destinationId
  );
  const body = await downloadStream(destination, objectKey);
  const swarmName = swarmServiceName(service);

  await withDeployClients(ctx, service.server, async ({ managerDocker }) => {
    await scaleServiceAndWait(managerDocker, swarmName, 0);

    const client = await connectTo(ctx, service.server);
    try {
      await ensureAlpineImage(client);
      await restoreVolumeStream(client, targetVolume, body);
    } finally {
      disconnect(client);
    }

    await scaleServiceAndWait(managerDocker, swarmName, 1);
  });
}
