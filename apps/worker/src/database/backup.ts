import { runBackupPipeline } from "#backup-run/pipeline";
import { databaseBackupSubject } from "#backup-run/subjects/database";
import type { DeployContext } from "#runtime-context";

/**
 * Runs an end-to-end backup and updates the row.
 *
 * The whole fix boils down to one sentence: **we never conclude from the
 * fact that the stream ended.** A `pg_dump` killed midway closes its
 * output cleanly, the object uploads with no error, and nothing in the
 * bytes says any are missing — measured against RustFS. Only the exit code
 * tells a backup apart from half a backup, and a corrupted backup
 * presented as good is worse than no backup at all.
 */
export async function runBackup(ctx: DeployContext, backupId: string): Promise<void> {
  await runBackupPipeline(databaseBackupSubject, ctx, backupId);
}
