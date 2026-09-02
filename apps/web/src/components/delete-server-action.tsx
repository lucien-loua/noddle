import { useMutation } from "@tanstack/react-query";
import { useCallback, useState } from "react";

import { ConfirmNameDialog } from "@/components/confirm-name-dialog";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/format";
import type { RoleName } from "@/lib/permissions";
import { useCan } from "@/lib/use-permission";
import { deleteServer } from "@/server/servers";

export function DeleteServerAction({
  onError,
  onRemoved,
  role,
  serverId,
  serverName,
}: {
  onError: (message: string) => void;
  onRemoved: () => void;
  role: RoleName | null;
  serverId: string;
  serverName: string;
}) {
  const canDelete = useCan(role, "server", "delete");
  const [open, setOpen] = useState(false);

  const remove = useMutation({
    mutationFn: (confirmName: string) =>
      deleteServer({ data: { confirmName, serverId } }),
    onError: (e: Error) => {
      setOpen(false);
      onError(errorMessage(e, "removal failed"));
    },
    onSuccess: onRemoved,
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
      <Button onClick={handleOpen} size="sm" variant="outline">
        Remove
      </Button>

      <ConfirmNameDialog
        confirmLabel="Remove server"
        description={
          <>
            The machine leaves the Swarm cluster and Noddle forgets it. Refused
            if it is the Swarm manager, or still hosts a service, a stack or a
            database. <strong>This cannot be undone.</strong>
          </>
        }
        onConfirm={handleConfirm}
        onOpenChange={setOpen}
        open={open}
        pending={remove.isPending}
        resourceName={serverName}
        title={`Remove ${serverName}?`}
      />
    </>
  );
}
