import { DotsThreeIcon } from "@phosphor-icons/react";
import { useMutation } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useCallback } from "react";

import { useCopyFeedback } from "@/components/copyable-value";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { errorMessage } from "@/lib/format";
import type { RoleName } from "@/lib/permissions";
import { useCan } from "@/lib/use-permission";
import { containerAction, restartSwarmService } from "@/server/containers";
import type { ContainerRow } from "@/server/containers";

/**
 * Whether the menu carries anything that CHANGES the container.
 *
 * Noddle's own containers never do: the button would destroy the process
 * serving the page. A Swarm task only does when its service is known,
 * since the restart targets the service and not the task.
 */
function canMutate(
  row: ContainerRow,
  role: { canDelete: boolean; canOperate: boolean }
): boolean {
  if (row.kind === "control-plane") {
    return false;
  }
  if (row.kind === "swarm") {
    return role.canOperate && row.serviceName !== null;
  }
  return role.canOperate || role.canDelete;
}

export function ContainerActions({
  onError,
  onTerminal,
  role,
  row,
}: {
  onError: (message: string) => void;
  /** Opens a shell in THIS container. `null` when the role cannot. */
  onTerminal: ((row: ContainerRow) => void) | null;
  role: RoleName | null;
  row: ContainerRow;
}) {
  const router = useRouter();
  const canOperate = useCan(role, "container", "operate");
  const canDelete = useCan(role, "container", "delete");
  const { handleCopy } = useCopyFeedback(row.id);

  const act = useMutation({
    mutationFn: (action: "stop" | "restart" | "remove") =>
      containerAction({
        data: { action, containerId: row.id, serverId: row.serverId },
      }),
    onError: (e: Error) => onError(errorMessage(e, "action failed")),
    onSuccess: () => router.invalidate(),
  });

  const restart = useMutation({
    mutationFn: () =>
      restartSwarmService({
        data: {
          serverId: row.serverId,
          serviceName: row.serviceName ?? "",
        },
      }),
    onError: (e: Error) => onError(errorMessage(e, "restart failed")),
    // Same as `act` above: restarting a Swarm service changes what the
    // container list reports, and without this the row keeps showing the
    // state from before the restart.
    onSuccess: () => router.invalidate(),
  });

  const handleStop = useCallback(() => act.mutate("stop"), [act]);
  const handleRestart = useCallback(() => act.mutate("restart"), [act]);
  const handleRemove = useCallback(() => act.mutate("remove"), [act]);
  const handleService = useCallback(() => restart.mutate(), [restart]);
  const handleTerminal = useCallback(
    () => onTerminal?.(row),
    [onTerminal, row]
  );

  const swarm = row.kind === "swarm";
  const running = row.state === "running";
  // A shell is offered on anything running that is not Noddle itself —
  // including a Swarm task, where looking inside is exactly the point and
  // nothing is destroyed. The server re-reads the kind before the exec.
  const shell = onTerminal && running && row.kind !== "control-plane";
  // Every row can be copied, so every row has a menu — including the
  // control plane, which used to have none and therefore no way to say
  // WHICH container it was.
  const mutations = canMutate(row, { canDelete, canOperate });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            aria-label={`Actions for ${row.name}`}
            disabled={act.isPending || restart.isPending}
            size="icon-sm"
            variant="ghost"
          >
            <DotsThreeIcon weight="regular" />
          </Button>
        }
      />
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={handleCopy}>
          Copy container ID
        </DropdownMenuItem>
        {shell ? (
          <DropdownMenuItem onClick={handleTerminal}>Terminal</DropdownMenuItem>
        ) : null}
        {mutations ? <DropdownMenuSeparator /> : null}
        {mutations && swarm ? (
          <DropdownMenuItem onClick={handleService}>
            Restart service
          </DropdownMenuItem>
        ) : null}
        {mutations && !swarm ? (
          <>
            {canOperate ? (
              <DropdownMenuItem disabled={!running} onClick={handleStop}>
                Stop
              </DropdownMenuItem>
            ) : null}
            {canOperate ? (
              <DropdownMenuItem onClick={handleRestart}>
                Restart
              </DropdownMenuItem>
            ) : null}
            {canDelete ? (
              <DropdownMenuItem disabled={running} onClick={handleRemove}>
                Remove
              </DropdownMenuItem>
            ) : null}
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
