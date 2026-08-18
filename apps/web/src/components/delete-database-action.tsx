import { useMutation } from "@tanstack/react-query";
import { useCallback, useState } from "react";

import { ConfirmNameDialog } from "@/components/confirm-name-dialog";
import { errorMessage } from "@/lib/format";
import type { RoleName } from "@/lib/permissions";
import { useCan } from "@/lib/use-permission";
import { deleteDatabase } from "@/server/databases";

export function useDeleteDatabaseAction({
  databaseId,
  databaseName,
  onDeleted,
  onError,
  role,
}: {
  databaseId: string;
  databaseName: string;
  onDeleted: () => void;
  onError: (message: string) => void;
  role: RoleName | null;
}) {
  const canDelete = useCan(role, "database", "delete");
  const [open, setOpen] = useState(false);

  const remove = useMutation({
    mutationFn: (confirmName: string) =>
      deleteDatabase({ data: { confirmName, databaseId } }),
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

  // The dialog is rendered WITHOUT a permission check: it's the caller who
  // decides whether to mount it, via `canDelete`. Mounting it here behind
  // an `if` would duplicate the decision in two places.
  const dialog = (
    <ConfirmNameDialog
      confirmLabel="Delete database"
      description={
        <>
          The running container and its volume are removed. The data does not
          survive this.{" "}
          {/* The backups' S3 objects, though, survive — see databases.ts:
                destroying them would remove the only way to recover what
                was just erased. */}
          Backups already taken stay in your S3 bucket.{" "}
          <strong>This cannot be undone.</strong>
        </>
      }
      onConfirm={handleConfirm}
      onOpenChange={setOpen}
      open={open}
      pending={remove.isPending}
      resourceName={databaseName}
      title={`Delete ${databaseName}?`}
    />
  );

  return { canDelete, dialog, handleOpen };
}
