import { useMutation } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useCallback, useState } from "react";

import { ConfirmNameDialog } from "@/components/confirm-name-dialog";
import { errorMessage } from "@/lib/format";
import type { RoleName } from "@/lib/permissions";
import { useCan } from "@/lib/use-permission";
import { deleteDatabase } from "@/server/databases";
import { deleteService } from "@/server/services";
import { deleteStack } from "@/server/stacks";

export type DeletableKind = "database" | "service" | "stack";

export function removeResource(
  kind: DeletableKind,
  id: string,
  confirmName: string
): Promise<unknown> {
  if (kind === "service") {
    return deleteService({ data: { confirmName, serviceId: id } });
  }
  if (kind === "stack") {
    return deleteStack({ data: { confirmName, stackId: id } });
  }
  return deleteDatabase({ data: { confirmName, databaseId: id } });
}

const DELETE_COPY: Record<
  DeletableKind,
  { confirmLabel: string; description: ReactNode }
> = {
  database: {
    confirmLabel: "Delete database",
    description: (
      <>
        The running container and its volume are removed. The data does not
        survive this. Backups already taken stay in your S3 bucket.{" "}
        <strong>This cannot be undone.</strong>
      </>
    ),
  },
  service: {
    confirmLabel: "Delete service",
    description: (
      <>
        The running container is stopped and removed, along with every
        deployment in its history, its build logs, its environment variables and
        its images in the registry. <strong>This cannot be undone.</strong>
      </>
    ),
  },
  stack: {
    confirmLabel: "Delete stack",
    description: (
      <>
        Every container in this stack is stopped and removed, along with its
        deployment history and build logs. Named volumes are kept: a Compose
        stack can hold data nobody asked to erase.{" "}
        <strong>This cannot be undone.</strong>
      </>
    ),
  },
};

const DELETE_PERMISSION: Record<DeletableKind, "database" | "service"> = {
  database: "database",
  service: "service",
  stack: "service",
};

export function useDeleteResourceAction({
  id,
  kind,
  name,
  onDeleted,
  onError,
  role,
  run,
}: {
  id: string;
  kind: DeletableKind;
  name: string;
  onDeleted: () => void;
  onError: (message: string) => void;
  role: RoleName | null;
  run?: (confirmName: string) => Promise<unknown>;
}) {
  const canDelete = useCan(role, DELETE_PERMISSION[kind], "delete");
  const [open, setOpen] = useState(false);

  const remove = useMutation({
    mutationFn: (confirmName: string) =>
      run ? run(confirmName) : removeResource(kind, id, confirmName),
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
      confirmLabel={DELETE_COPY[kind].confirmLabel}
      description={DELETE_COPY[kind].description}
      onConfirm={handleConfirm}
      onOpenChange={setOpen}
      open={open}
      pending={remove.isPending}
      resourceName={name}
      title={`Delete ${name}?`}
    />
  );

  return { canDelete, dialog, handleOpen };
}
