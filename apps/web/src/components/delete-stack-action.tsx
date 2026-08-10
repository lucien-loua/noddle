import { useMutation } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { ConfirmNameDialog } from "@/components/confirm-name-dialog";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/format";
import type { RoleName } from "@/lib/permissions";
import { useCan } from "@/lib/use-permission";
import { deleteStack } from "@/server/stacks";

export function DeleteStackAction({
  onDeleted,
  onError,
  role,
  stackId,
  stackName,
}: {
  onDeleted: () => void;
  onError: (message: string) => void;
  role: RoleName | null;
  stackId: string;
  stackName: string;
}) {
  const canDelete = useCan(role, "service", "delete");
  const [open, setOpen] = useState(false);

  const remove = useMutation({
    mutationFn: (confirmName: string) =>
      deleteStack({ data: { confirmName, stackId } }),
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

  if (!canDelete) {
    return null;
  }

  return (
    <>
      <Button onClick={handleOpen} variant="outline">
        Delete
      </Button>

      <ConfirmNameDialog
        confirmLabel="Delete stack"
        description={
          <>
            Every container in this stack is stopped and removed, along with its
            deployment history and build logs.{" "}
            {/* Volumes SURVIVE, by design — see teardown-stack.ts: an
                arbitrary Compose stack can carry someone's database, and
                the user never explicitly designated it for deletion. */}
            Named volumes are kept — a Compose stack can hold data nobody asked
            to erase. <strong>This cannot be undone.</strong>
          </>
        }
        onConfirm={handleConfirm}
        onOpenChange={setOpen}
        open={open}
        pending={remove.isPending}
        resourceName={stackName}
        title={`Delete ${stackName}?`}
      />
    </>
  );
}
