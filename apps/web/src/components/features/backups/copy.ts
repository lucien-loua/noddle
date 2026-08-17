import { ArchiveIcon, HardDrivesIcon } from "@phosphor-icons/react";

import type { BackupSubject } from "@/lib/backup-subject";

export type BackupKind = BackupSubject["kind"];

export const backupCopy = {
  database: {
    createLabel: "Add schedule",
    description: "Dump this database to S3 on a schedule.",
    dialogDescriptionEdit:
      "Changes apply to the next run. A dump already in flight keeps its original settings.",
    dialogDescriptionNew:
      "How often Noddle should dump this database, and which destination receives the file.",
    dialogTitleEdit: "Edit schedule",
    dialogTitleNew: "Add schedule",
    emptyDescription: (name: string) =>
      `Nothing dumps ${name} on a cadence yet. Add a schedule, or restore from a dump already sitting in a destination.`,
    emptyHistoryDescription:
      "Run this schedule once, or wait for the next cron fire. Completed dumps show up here with size and timing.",
    emptyHistoryTitle: "No dumps yet",
    emptyIcon: ArchiveIcon,
    emptyTitle: "No schedules yet",
    historyAria: "Dump history",
    historyTitle: "Dump history",
    noDestination: "Noddle needs somewhere to push dumps before a schedule can run. Add one under",
    queueErrorTitle: "Could not queue backup",
    queuedToast: "Backup queued",
    restoreConfirmLabel: "Restore database",
    restoreLabel: "Restore dump",
    runTitle: "Dump run",
    s3Description:
      "Pick a dump already in the bucket. Noddle takes a safety dump first so the restore stays reversible.",
    s3Empty: "No dump objects under this destination prefix.",
    title: "Backups",
  },
  volume: {
    createLabel: "Add volume backup",
    description: "Tar Docker volumes on the server to S3 on a schedule.",
    dialogDescriptionEdit:
      "Changes apply to the next run. A backup already in flight keeps its original settings.",
    dialogDescriptionNew: "Tar a Docker volume on the service's server to S3 on a schedule.",
    dialogTitleEdit: "Edit volume backup",
    dialogTitleNew: "Add volume backup",
    emptyDescription: (name: string) =>
      `Nothing archives volumes for ${name} yet. Add a schedule, or restore from an archive already sitting in a destination.`,
    emptyHistoryDescription:
      "Run this schedule once, or wait for the next cron fire. Completed archives show up here with size and timing.",
    emptyHistoryTitle: "No backups yet",
    emptyIcon: HardDrivesIcon,
    emptyTitle: "No volume backups",
    historyAria: "Backup history",
    historyTitle: "Volume backup history",
    noDestination:
      "Noddle needs somewhere to push volume archives before a schedule can run. Add one under",
    queueErrorTitle: "Could not queue volume backup",
    queuedToast: "Volume backup queued",
    restoreConfirmLabel: "Restore volume",
    restoreLabel: "Restore volume backup",
    runTitle: "Volume backup run",
    s3Description:
      "Pick a tar.gz archive already in the bucket. Noddle scales the service down before writing into the target volume.",
    s3Empty: "No volume archives under this destination prefix.",
    title: "Volume backups",
  },
} as const;

export function copyFor(kind: BackupKind) {
  return backupCopy[kind];
}
