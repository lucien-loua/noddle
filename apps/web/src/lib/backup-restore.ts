import type { BackupRestoreTarget } from "@/components/features/backups/restore-types";
import type { BackupSubject } from "@/lib/backup-subject";
import { triggerRestore } from "@/server/backups/runs";
import { triggerVolumeRestore } from "@/server/backups/volume/runs";

export function queueBackupRestore(
  subject: BackupSubject,
  confirmName: string,
  target: BackupRestoreTarget
): Promise<{ queued: true }> {
  if (subject.kind === "database") {
    if (target.kind === "run") {
      return triggerRestore({
        data: {
          backupId: target.backup.id,
          confirmName,
          databaseId: subject.databaseId,
        },
      });
    }
    return triggerRestore({
      data: {
        confirmName,
        databaseId: subject.databaseId,
        destinationId: target.destinationId,
        objectKey: target.objectKey,
      },
    });
  }

  if (target.kind === "run") {
    return triggerVolumeRestore({
      data: {
        backupId: target.backup.id,
        confirmName,
        serviceId: subject.serviceId,
      },
    });
  }
  if (!target.volumeName) {
    return Promise.reject(
      new Error("volumeName is required when restoring from an S3 object")
    );
  }
  return triggerVolumeRestore({
    data: {
      confirmName,
      destinationId: target.destinationId,
      objectKey: target.objectKey,
      serviceId: subject.serviceId,
      volumeName: target.volumeName,
    },
  });
}
