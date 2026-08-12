import { useMutation, useQuery } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { VolumeBackupPanel } from "@/components/features/volume-backups/panel";
import { VolumeRestoreDialog } from "@/components/features/volume-backups/restore-dialog";
import type { VolumeRestoreTarget } from "@/components/features/volume-backups/types";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { queries } from "@/lib/queries";
import type { DestinationRow } from "@/server/backups";
import { triggerVolumeRestore } from "@/server/volume-backups";

export function ServiceVolumeBackupsTab({
  canCreate,
  canRestore,
  serviceId,
  serviceName,
}: {
  canCreate: boolean;
  canRestore: boolean;
  serviceId: string;
  serviceName: string;
}) {
  const destinationsQuery = useQuery(queries.destinations());
  const destinations: DestinationRow[] = destinationsQuery.data ?? [];

  const [restoreTarget, setRestoreTarget] =
    useState<VolumeRestoreTarget | null>(null);
  const restore = useMutation({
    mutationFn: (confirmName: string) => {
      if (!restoreTarget) {
        throw new Error("no restore target");
      }
      if (restoreTarget.kind === "run") {
        return triggerVolumeRestore({
          data: {
            backupId: restoreTarget.backup.id,
            confirmName,
            serviceId,
          },
        });
      }
      return triggerVolumeRestore({
        data: {
          confirmName,
          destinationId: restoreTarget.destinationId,
          objectKey: restoreTarget.objectKey,
          serviceId,
          volumeName: restoreTarget.volumeName,
        },
      });
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

  return (
    <>
      <VolumeBackupPanel
        canCreate={canCreate}
        canRestore={canRestore}
        destinations={destinations}
        onRestore={setRestoreTarget}
        serviceId={serviceId}
        serviceName={serviceName}
      />
      {restore.isError ? (
        <Alert className="mt-3" variant="destructive">
          <AlertDescription>
            {restore.error instanceof Error
              ? restore.error.message
              : "restore refused"}
          </AlertDescription>
        </Alert>
      ) : null}
      <VolumeRestoreDialog
        onConfirm={handleRestoreConfirm}
        onOpenChange={handleRestoreClose}
        pending={restore.isPending}
        serviceName={serviceName}
        target={restoreTarget}
      />
    </>
  );
}
