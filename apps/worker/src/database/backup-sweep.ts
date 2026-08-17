import {
  pruneDatabaseBackups,
  sweepDatabaseBackups,
} from "#backup-run/subjects/database";
import type { DeployContext } from "#runtime-context";

export type { BackupSweepResult } from "#backup-run/sweep";

export async function sweepBackups(
  ctx: DeployContext,
  enqueue: (backupId: string) => Promise<unknown>
) {
  return await sweepDatabaseBackups(ctx, enqueue);
}

export async function pruneBackups(
  ctx: DeployContext,
  opts: { configId: string | null; databaseId: string }
): Promise<string[]> {
  return await pruneDatabaseBackups(ctx, opts);
}
