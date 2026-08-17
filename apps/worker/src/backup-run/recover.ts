import type { DeployContext } from "#runtime-context";

const STALE_MESSAGE = "interrupted — worker restarted while backup was in progress";

export interface BackupRecoverSubject {
  findRunningIds: (ctx: DeployContext) => Promise<string[]>;
  markStaleFailed: (ctx: DeployContext, ids: string[], message: string) => Promise<void>;
}

export async function recoverStaleBackupRuns(
  subject: BackupRecoverSubject,
  ctx: DeployContext,
): Promise<number> {
  const ids = await subject.findRunningIds(ctx);
  if (ids.length === 0) {
    return 0;
  }

  await subject.markStaleFailed(ctx, ids, STALE_MESSAGE);
  return ids.length;
}
