import { DotsThreeIcon } from "@phosphor-icons/react";
import { useMutation } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useCallback } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { errorMessage } from "@/lib/format";
import type { RoleName } from "@/lib/permissions";
import { useCan } from "@/lib/use-permission";
import {
  type ContainerRow,
  containerAction,
  restartSwarmService,
} from "@/server/containers";

export function ContainerActions({
  onError,
  role,
  row,
}: {
  onError: (message: string) => void;
  role: RoleName | null;
  row: ContainerRow;
}) {
  const router = useRouter();
  const canOperate = useCan(role, "container", "operate");
  const canDelete = useCan(role, "container", "delete");

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
      restartSwarmService({ data: { serviceName: row.serviceName ?? "" } }),
    onError: (e: Error) => onError(errorMessage(e, "restart failed")),
  });

  const handleStop = useCallback(() => act.mutate("stop"), [act]);
  const handleRestart = useCallback(() => act.mutate("restart"), [act]);
  const handleRemove = useCallback(() => act.mutate("remove"), [act]);
  const handleService = useCallback(() => restart.mutate(), [restart]);

  if (row.kind === "control-plane") {
    return null;
  }

  const swarm = row.kind === "swarm";
  const running = row.state === "running";
  const usable = swarm
    ? canOperate && row.serviceName
    : canOperate || canDelete;
  if (!usable) {
    return null;
  }

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
            <DotsThreeIcon weight="bold" />
          </Button>
        }
      />
      <DropdownMenuContent align="end">
        {swarm ? (
          <DropdownMenuItem onClick={handleService}>
            Restart service
          </DropdownMenuItem>
        ) : (
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
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
