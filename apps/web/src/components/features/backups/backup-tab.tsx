/**
 * biome-ignore-all lint/performance/noJsxPropsBind: restore confirmation flow;
 * dialog open/close handlers are tied to local restore target state.
 */
import { useMutation, useQuery } from "@tanstack/react-query";
import { useCallback, useState } from "react";

import { BackupPanel } from "@/components/features/backups/panel";
import { RestoreDialog } from "@/components/features/backups/restore-dialog";
import type { BackupRestoreTarget } from "@/components/features/backups/restore-types";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { queueBackupRestore } from "@/lib/backup-restore";
import type {
  DatabaseBackupSubject,
  VolumeBackupSubject,
} from "@/lib/backup-subject";
import { queries } from "@/lib/queries";
import type { DestinationRow } from "@/server/backups/destinations";

export type BackupTabProps =
  | {
      canCreate: boolean;
      canRestore: boolean;
      defaultDatabaseName: string;
      resourceName: string;
      subject: DatabaseBackupSubject;
    }
  | {
      canCreate: boolean;
      canRestore: boolean;
      resourceName: string;
      subject: VolumeBackupSubject;
    };

function isDatabaseTab(
  props: BackupTabProps
): props is Extract<BackupTabProps, { subject: DatabaseBackupSubject }> {
  return props.subject.kind === "database";
}

function useBackupRestore(subject: BackupTabProps["subject"]) {
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

export function BackupTab(props: BackupTabProps) {
  const destinationsQuery = useQuery(queries.destinations());
  const destinations: DestinationRow[] = destinationsQuery.data ?? [];
  const restore = useBackupRestore(props.subject);

  const panel = isDatabaseTab(props) ? (
    <BackupPanel
      canCreate={props.canCreate}
      canRestore={props.canRestore}
      defaultDatabaseName={props.defaultDatabaseName}
      destinations={destinations}
      onRestore={restore.setRestoreTarget}
      resourceName={props.resourceName}
      subject={props.subject}
    />
  ) : (
    <BackupPanel
      canCreate={props.canCreate}
      canRestore={props.canRestore}
      destinations={destinations}
      onRestore={restore.setRestoreTarget}
      resourceName={props.resourceName}
      subject={props.subject}
    />
  );

  return (
    <>
      {panel}
      {restore.restoreError ? (
        <Alert className="mt-3" variant="destructive">
          <AlertDescription>{restore.restoreError.message}</AlertDescription>
        </Alert>
      ) : null}
      <RestoreDialog
        onConfirm={restore.handleRestoreConfirm}
        onOpenChange={restore.handleRestoreClose}
        pending={restore.pending}
        resourceName={props.resourceName}
        subject={props.subject}
        target={restore.restoreTarget}
      />
    </>
  );
}
