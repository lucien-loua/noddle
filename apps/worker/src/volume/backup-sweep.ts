import { sweepVolumeBackupConfigs } from "#backup-run/subjects/volume";
import type { DeployContext } from "#runtime-context";

export type { BackupSweepResult as VolumeBackupSweepResult } from "#backup-run/sweep";

export async function sweepVolumeBackups(
  ctx: DeployContext,
  enqueue: (volumeBackupId: string) => Promise<unknown>
) {
  return await sweepVolumeBackupConfigs(ctx, enqueue);
}
