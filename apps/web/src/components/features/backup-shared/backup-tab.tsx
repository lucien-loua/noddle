/**
 * biome-ignore-all lint/performance/noJsxPropsBind: restore confirmation flow;
 * dialog open/close handlers are tied to local restore target state.
 */
import { useMutation, useQuery } from "@tanstack/react-query";
import { type ReactNode, useCallback, useState } from "react";
import type { BackupRestoreTarget } from "@/components/features/backup-shared/restore-types";
import { BackupPanel } from "@/components/features/backups/panel";
import { RestoreDialog } from "@/components/features/backups/restore-dialog";
import type { RestoreTarget } from "@/components/features/backups/types";
import { VolumeBackupPanel } from "@/components/features/volume-backups/panel";
import { VolumeRestoreDialog } from "@/components/features/volume-backups/restore-dialog";
import type { VolumeRestoreTarget } from "@/components/features/volume-backups/types";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { queueBackupRestore } from "@/lib/backup-restore";
import type { BackupSubject } from "@/lib/backup-subject";
import { queries } from "@/lib/queries";
import type { DestinationRow } from "@/server/backups";

interface DatabaseBackupTab {
  canCreate: boolean;
  canRestore: boolean;
  defaultDatabaseName: string;
  resourceName: string;
  subject: Extract<BackupSubject, { kind: "database" }>;
}

interface VolumeBackupTab {
  canCreate: boolean;
  canRestore: boolean;
  resourceName: string;
  subject: Extract<BackupSubject, { kind: "volume" }>;
}

export type BackupTabProps = DatabaseBackupTab | VolumeBackupTab;

function toDatabaseRestoreTarget(target: BackupRestoreTarget): RestoreTarget {
  if (target.kind === "run") {
    return { backup: target.backup, kind: "run" };
  }
  return {
    destinationId: target.destinationId,
    kind: "object",
    objectKey: target.objectKey,
  };
}

function toVolumeRestoreTarget(
  target: BackupRestoreTarget
): VolumeRestoreTarget {
  if (target.kind === "run") {
    return { backup: target.backup, kind: "run" };
  }
  if (!target.volumeName) {
    throw new Error("volumeName is required for volume restore from S3");
  }
  return {
    destinationId: target.destinationId,
    kind: "object",
    objectKey: target.objectKey,
    volumeName: target.volumeName,
  };
}

function BackupTabShell({
  confirmDialog,
  panel,
  restoreError,
}: {
  confirmDialog: ReactNode;
  panel: ReactNode;
  restoreError: Error | null;
}) {
  return (
    <>
      {panel}
      {restoreError ? (
        <Alert className="mt-3" variant="destructive">
          <AlertDescription>{restoreError.message}</AlertDescription>
        </Alert>
      ) : null}
      {confirmDialog}
    </>
  );
}

function useBackupRestore(subject: BackupSubject) {
  const [restoreTarget, setRestoreTarget] =
    useState<BackupRestoreTarget | null>(null);

  const restore = useMutation({
    mutationFn: (confirmName: string) => {
      if (!restoreTarget) {
        throw new Error("no restore target");
      }
      return queueBackupRestore(subject, confirmName, restoreTarget);
    },
    onSuccess: () => setRestoreTarget(null),
  });

  const handleRestoreClose = useCallback((open: boolean) => {
    if (!open) {
      setRestoreTarget(null);
    }
  }, []);
  const handleRestoreConfirm = useCallback(
    (confirmName: string) => restore.mutate(confirmName),
    [restore]
  );

  return {
    handleRestoreClose,
    handleRestoreConfirm,
    pending: restore.isPending,
    restoreError: restore.error instanceof Error ? restore.error : null,
    restoreTarget,
    setRestoreTarget,
  };
}

function DatabaseBackupTabView(props: DatabaseBackupTab) {
  const destinationsQuery = useQuery(queries.destinations());
  const destinations: DestinationRow[] = destinationsQuery.data ?? [];
  const restore = useBackupRestore(props.subject);

  return (
    <BackupTabShell
      confirmDialog={
        <RestoreDialog
          databaseName={props.resourceName}
          onConfirm={restore.handleRestoreConfirm}
          onOpenChange={restore.handleRestoreClose}
          pending={restore.pending}
          target={
            restore.restoreTarget
              ? toDatabaseRestoreTarget(restore.restoreTarget)
              : null
          }
        />
      }
      panel={
        <BackupPanel
          canCreate={props.canCreate}
          canRestore={props.canRestore}
          databaseId={props.subject.databaseId}
          databaseName={props.resourceName}
          defaultDatabaseName={props.defaultDatabaseName}
          destinations={destinations}
          onRestore={(target) =>
            restore.setRestoreTarget(toDatabaseRestoreTarget(target))
          }
        />
      }
      restoreError={restore.restoreError}
    />
  );
}

function VolumeBackupTabView(props: VolumeBackupTab) {
  const destinationsQuery = useQuery(queries.destinations());
  const destinations: DestinationRow[] = destinationsQuery.data ?? [];
  const restore = useBackupRestore(props.subject);

  return (
    <BackupTabShell
      confirmDialog={
        <VolumeRestoreDialog
          onConfirm={restore.handleRestoreConfirm}
          onOpenChange={restore.handleRestoreClose}
          pending={restore.pending}
          serviceName={props.resourceName}
          target={
            restore.restoreTarget
              ? toVolumeRestoreTarget(restore.restoreTarget)
              : null
          }
        />
      }
      panel={
        <VolumeBackupPanel
          canCreate={props.canCreate}
          canRestore={props.canRestore}
          destinations={destinations}
          onRestore={(target) =>
            restore.setRestoreTarget(toVolumeRestoreTarget(target))
          }
          serviceId={props.subject.serviceId}
          serviceName={props.resourceName}
        />
      }
      restoreError={restore.restoreError}
    />
  );
}

export function BackupTab(props: BackupTabProps) {
  if (props.subject.kind === "database") {
    const dbProps = props as DatabaseBackupTab;
    return <DatabaseBackupTabView {...dbProps} />;
  }
  const volProps = props as VolumeBackupTab;
  return <VolumeBackupTabView {...volProps} />;
}
