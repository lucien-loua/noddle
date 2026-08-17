import { useMutation } from "@tanstack/react-query";
import { useCallback, useState } from "react";

import { ConfirmNameDialog } from "@/components/confirm-name-dialog";
import { errorMessage } from "@/lib/format";
import type { RoleName } from "@/lib/permissions";
import { useCan } from "@/lib/use-permission";
import { deleteService } from "@/server/services";

export function useDeleteServiceAction({
  onDeleted,
  onError,
  role,
  serviceId,
  serviceName,
}: {
  onDeleted: () => void;
  onError: (message: string) => void;
  role: RoleName | null;
  serviceId: string;
  serviceName: string;
}) {
  // The permission is decided HERE, alongside the action it guards, rather
  // than by one more ternary in the route — which already carried too many
  // branches. Courtesy only: `deleteService` re-checks it server-side.
  const canDelete = useCan(role, "service", "delete");
  const [open, setOpen] = useState(false);

  const remove = useMutation({
    mutationFn: (confirmName: string) =>
      deleteService({ data: { confirmName, serviceId } }),
    onError: (e: Error) => {
      setOpen(false);
      onError(errorMessage(e, "deletion failed"));
    },
    onSuccess: onDeleted,
  });

  const handleOpen = useCallback(() => setOpen(true), []);
  const handleConfirm = useCallback(
    (typed: string) => remove.mutate(typed),
    [remove]
  );

  const dialog = (
    <ConfirmNameDialog
      confirmLabel="Delete service"
      description={
        // State what's being lost, not "are you sure". The history and the
        // images are what nobody can reconstruct.
        <>
          The running container is stopped and removed, along with every
          deployment in its history, its build logs, its environment variables
          and its images in the registry.{" "}
          <strong>This cannot be undone.</strong>
        </>
      }
      onConfirm={handleConfirm}
      onOpenChange={setOpen}
      open={open}
      pending={remove.isPending}
      resourceName={serviceName}
      title={`Delete ${serviceName}?`}
    />
  );

  return { canDelete, dialog, handleOpen };
}
