import type { Readable } from "node:stream";

import { resolveDestination } from "@noddle/backup";
import { deleteObject, uploadStream } from "@noddle/backup-store";
import type { BackupDestination } from "@noddle/backup-store";
import { uploadedSize } from "@noddle/backup/uploaded-size";
import type { servers } from "@noddle/db/schema";
import { disconnect, execStream } from "@noddle/ssh-executor";
import type { SshClient } from "@noddle/ssh-executor";

import { notify } from "#notify";
import type { DeployContext } from "#runtime-context";

type ServerRow = typeof servers.$inferSelect;

export interface BackupRunRow {
  configDestinationId: string | null;
  configId: string | null;
  destinationId: string | null;
  id: string;
  objectKey: string;
}

export interface BackupSubject<T extends BackupRunRow> {
  capture: (
    ctx: DeployContext,
    client: SshClient,
    run: T,
    destination: BackupDestination
  ) => Promise<{ code: number; stderr: string }>;
  incompleteMessage: (code: number, stderr: string) => string;
  loadRun: (ctx: DeployContext, runId: string) => Promise<T | null>;
  markCompleted: (
    ctx: DeployContext,
    runId: string,
    sizeBytes: number
  ) => Promise<void>;
  markFailed: (
    ctx: DeployContext,
    runId: string,
    message: string
  ) => Promise<void>;
  markRunning: (
    ctx: DeployContext,
    runId: string,
    destinationId: string
  ) => Promise<void>;
  notFoundMessage: (runId: string) => string;
  notifyResource: (run: T) => string;
  prune: (ctx: DeployContext, run: T) => Promise<void>;
  server: (run: T) => ServerRow;
}

async function captureToS3(
  client: SshClient,
  command: string,
  destination: Awaited<ReturnType<typeof resolveDestination>>["destination"],
  objectKey: string
): Promise<{ code: number; stderr: string }> {
  const result = await execStream(client, command, (io) =>
    uploadStream(destination, objectKey, io.stdout as Readable)
  );
  return { code: result.code ?? -1, stderr: result.stderr };
}

export async function runBackupPipeline<T extends BackupRunRow>(
  subject: BackupSubject<T>,
  ctx: DeployContext,
  runId: string
): Promise<void> {
  const run = await subject.loadRun(ctx, runId);
  if (!run) {
    throw new Error(subject.notFoundMessage(runId));
  }

  const { destination, id: destinationId } = await resolveDestination(
    ctx.db,
    ctx.appKey,
    run.destinationId ?? run.configDestinationId
  );

  await subject.markRunning(ctx, runId, destinationId);
  const client = await ctx.connectTo(subject.server(run));

  try {
    const { code, stderr } = await subject.capture(
      ctx,
      client,
      run,
      destination
    );

    if (code !== 0) {
      await deleteObject(destination, run.objectKey).catch(() => {});
      throw new Error(subject.incompleteMessage(code, stderr));
    }

    const sizeBytes = await uploadedSize(destination, run.objectKey);
    await subject.markCompleted(ctx, runId, sizeBytes);

    try {
      await subject.prune(ctx, run);
    } catch {}
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await subject.markFailed(ctx, runId, message);
    await notify(ctx, {
      detail: message,
      resource: subject.notifyResource(run),
      type: "backup_failed",
    });
    throw error;
  } finally {
    disconnect(client);
  }
}

export { captureToS3 };
