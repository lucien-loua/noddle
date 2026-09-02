import { runBackupPipeline } from "#backup-run/pipeline";
import { volumeBackupSubject } from "#backup-run/subjects/volume";
import type { DeployContext } from "#runtime-context";

export async function runVolumeBackup(
  ctx: DeployContext,
  volumeBackupId: string
): Promise<void> {
  await runBackupPipeline(volumeBackupSubject, ctx, volumeBackupId);
}
