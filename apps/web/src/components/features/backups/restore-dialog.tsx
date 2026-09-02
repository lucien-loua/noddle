import type { ReactNode } from "react";

import { ConfirmNameDialog } from "@/components/confirm-name-dialog";
import type { BackupRestoreTarget } from "@/components/features/backups/restore-types";
import type { BackupSubject } from "@/lib/backup-subject";
import { relativeTime } from "@/lib/format";

import { copyFor } from "./copy";

function databaseRestoreDescription(target: BackupRestoreTarget | null) {
  if (target?.kind === "run") {
    return (
      <>
        The live data in this database will be{" "}
        <strong>permanently replaced</strong> by the dump taken{" "}
        {relativeTime(target.backup.createdAt)}. Noddle writes a safety dump
        first, so you can undo the restore if needed.
      </>
    );
  }

  return (
    <>
      The live data in this database will be{" "}
      <strong>permanently replaced</strong> by
      {target?.kind === "object" ? (
        <>
          {" "}
          <code className="text-xs">{target.objectKey}</code>
        </>
      ) : (
        " the selected dump"
      )}
      . Noddle writes a safety dump first.
    </>
  );
}

function volumeRestoreDescription(target: BackupRestoreTarget | null) {
  if (target?.kind === "run") {
    return (
      <>
        The live volume data for this service will be{" "}
        <strong>permanently replaced</strong> by the archive taken{" "}
        {relativeTime(target.backup.createdAt)}. Noddle scales the service down,
        writes a safety backup first, then restores the tar archive.
      </>
    );
  }

  if (target?.kind === "object") {
    return (
      <>
        The live volume data for this service will be{" "}
        <strong>permanently replaced</strong> by{" "}
        <code className="text-xs">{target.objectKey}</code> into volume{" "}
        <code className="text-xs">{target.volumeName}</code>. Noddle scales the
        service down during the restore.
      </>
    );
  }

  return (
    <>
      The live volume data for this service will be{" "}
      <strong>permanently replaced</strong> by the selected archive. Noddle
      scales the service down during the restore.
    </>
  );
}

export function RestoreDialog({
  onConfirm,
  onOpenChange,
  pending,
  resourceName,
  subject,
  target,
}: {
  onConfirm: (confirmName: string) => void;
  onOpenChange: (open: boolean) => void;
  pending: boolean;
  resourceName: string;
  subject: BackupSubject;
  target: BackupRestoreTarget | null;
}) {
  const copy = copyFor(subject.kind);
  const description: ReactNode =
    subject.kind === "database"
      ? databaseRestoreDescription(target)
      : volumeRestoreDescription(target);

  return (
    <ConfirmNameDialog
      confirmLabel={copy.restoreConfirmLabel}
      description={description}
      onConfirm={onConfirm}
      onOpenChange={onOpenChange}
      open={target !== null}
      pending={pending}
      resourceName={resourceName}
      title={`Restore ${resourceName}?`}
    />
  );
}
