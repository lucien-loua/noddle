import { runBackupPipeline } from "#backup-run/pipeline";
import { databaseBackupSubject } from "#backup-run/subjects/database";
import type { DeployContext } from "#runtime-context";

export async function runBackup(
  ctx: DeployContext,
  backupId: string
): Promise<void> {
  await runBackupPipeline(databaseBackupSubject, ctx, backupId);
}
