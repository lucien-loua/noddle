import { useMutation } from "@tanstack/react-query";
import { useCallback } from "react";
import { errorMessage } from "@/lib/format";
import type { RoleName } from "@/lib/permissions";
import { useCan } from "@/lib/use-permission";
import { triggerDatabaseLifecycle } from "@/server/databases";
import { triggerLifecycle } from "@/server/deployments";

type Action = "restart" | "start" | "stop";

/**
 * Start/stop/restart, for a Service or a Database — the two resources with
 * a Swarm service to operate. Parametrized by `resource` rather than
 * duplicated: the two call sites differed only in which server function
 * they called, which permission resource string they checked, and the
 * shape of the mutation payload.
 */
type LifecycleTarget =
  | { databaseId: string; resource: "database" }
  | { resource: "service"; serviceId: string };

function runLifecycle(
  target: LifecycleTarget,
  action: Action
): Promise<unknown> {
  return target.resource === "database"
    ? triggerDatabaseLifecycle({
        data: { action, databaseId: target.databaseId },
      })
    : triggerLifecycle({ data: { action, serviceId: target.serviceId } });
}

export function useLifecycleActions({
  onDone,
  onError,
  role,
  status,
  target,
}: {
  onDone: () => void;
  onError: (message: string) => void;
  role: RoleName | null;
  status: string;
  target: LifecycleTarget;
}) {
  const canOperate = useCan(role, target.resource, "operate");

  const run = useMutation({
    mutationFn: (action: Action) => runLifecycle(target, action),
    onError: (e: Error) => onError(errorMessage(e, "action refused")),
    onSuccess: onDone,
  });

  const stop = useCallback(() => run.mutate("stop"), [run]);
  const start = useCallback(() => run.mutate("start"), [run]);
  const restart = useCallback(() => run.mutate("restart"), [run]);

  const stopped = status === "stopped";
  // `created` = never provisioned, `deleting` = teardown in progress: in
  // both cases there is no stable Swarm service to operate, and offering
  // the action would lie about what's possible.
  const available = canOperate && status !== "created" && status !== "deleting";

  return {
    available,
    busy: run.isPending,
    handleRestart: restart,
    handleStopStart: stopped ? start : stop,
    showRestart: !stopped,
    stopped,
  };
}
