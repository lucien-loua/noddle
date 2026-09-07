import { useMutation, useQuery } from "@tanstack/react-query";
import { useCallback, useState } from "react";

import { ConfirmActionDialog } from "@/components/confirm-action-dialog";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  FocusModal,
  FocusModalBody,
  FocusModalContent,
  FocusModalHeader,
  FocusModalTitle,
} from "@/components/ui/focus-modal";
import { toast } from "@/components/ui/toast";
import { byteSize, errorMessage, relativeTime } from "@/lib/format";
import {
  getControlPlaneBackups,
  restoreControlPlane,
} from "@/server/control-plane";
import type { ControlPlaneBackupObject } from "@/server/control-plane";

export function ControlPlaneRestoreDialog({
  onOpenChange,
  open,
}: {
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const [chosen, setChosen] = useState<ControlPlaneBackupObject | null>(null);

  const archives = useQuery<ControlPlaneBackupObject[]>({
    enabled: open,
    queryFn: () => getControlPlaneBackups(),
    queryKey: ["control-plane-backups"],
  });

  const restore = useMutation({
    mutationFn: (key: string) => restoreControlPlane({ data: { key } }),
    onError: (error: Error) =>
      toast.add({
        description: errorMessage(error, "restore failed"),
        title: "Could not queue the restore",
        type: "error",
      }),
    onSuccess: () => {
      setChosen(null);
      onOpenChange(false);
      toast.add({ title: "Restore queued", type: "success" });
    },
  });

  const handleConfirm = useCallback(() => {
    if (chosen) {
      restore.mutate(chosen.key);
    }
  }, [chosen, restore]);

  const closeConfirm = useCallback(() => setChosen(null), []);

  const rows = archives.data ?? [];

  return (
    <FocusModal onOpenChange={onOpenChange} open={open}>
      <FocusModalContent>
        <FocusModalHeader>
          <FocusModalTitle>Restore the control plane</FocusModalTitle>
        </FocusModalHeader>
        <FocusModalBody className="flex min-h-0 flex-col">
          {rows.length === 0 ? (
            <Empty className="border-0">
              <EmptyHeader>
                <EmptyTitle>No archive yet</EmptyTitle>
                <EmptyDescription>
                  Nothing has been backed up to this destination. Take a backup
                  first.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ul className="space-y-1.5">
              {rows.map((archive) => (
                <li
                  className="flex items-center justify-between gap-3 rounded-2xl bg-muted p-3 text-xs"
                  key={archive.key}
                >
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span>
                      {archive.takenAt
                        ? relativeTime(archive.takenAt)
                        : "unknown date"}
                    </span>
                    <span className="truncate font-mono text-muted-foreground">
                      {archive.key} · {byteSize(archive.size)}
                    </span>
                  </span>
                  <Button
                    onClick={() => setChosen(archive)}
                    size="xs"
                    variant="outline"
                  >
                    Restore
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </FocusModalBody>
      </FocusModalContent>

      <ConfirmActionDialog
        confirmLabel="Restore"
        description={`This replaces the control plane database, /etc/noddle and APP_KEY with the contents of ${chosen?.key ?? ""}. Anything recorded since — servers, deployments, secrets — is lost, and the dashboard restarts to pick up the restored key. The database is restored in a single transaction, so it either completes or is left untouched.`}
        onConfirm={handleConfirm}
        onOpenChange={closeConfirm}
        open={chosen !== null}
        pending={restore.isPending}
        title="Restore the control plane"
      />
    </FocusModal>
  );
}
