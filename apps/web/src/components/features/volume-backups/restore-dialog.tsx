import { ConfirmNameDialog } from "@/components/confirm-name-dialog";
import { volumeRestoreDescription } from "./restore-description";
import type { VolumeRestoreTarget } from "./types";

export function VolumeRestoreDialog({
  onConfirm,
  onOpenChange,
  pending,
  serviceName,
  target,
}: {
  onConfirm: (confirmName: string) => void;
  onOpenChange: (open: boolean) => void;
  pending: boolean;
  serviceName: string;
  target: VolumeRestoreTarget | null;
}) {
  return (
    <ConfirmNameDialog
      confirmLabel="Restore volume"
      description={volumeRestoreDescription(target)}
      onConfirm={onConfirm}
      onOpenChange={onOpenChange}
      open={target !== null}
      pending={pending}
      resourceName={serviceName}
      title={`Restore ${serviceName}?`}
    />
  );
}
