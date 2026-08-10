import { useMutation } from "@tanstack/react-query";
import { useCallback } from "react";
import { errorMessage } from "@/lib/format";
import type { RoleName } from "@/lib/permissions";
import { useCan } from "@/lib/use-permission";
import { triggerDatabaseLifecycle } from "@/server/databases";

type Action = "restart" | "start" | "stop";

export function useDatabaseLifecycleActions({
  databaseId,
  onDone,
  onError,
  role,
  status,
}: {
  databaseId: string;
  onDone: () => void;
  onError: (message: string) => void;
  role: RoleName | null;
  status: string;
}) {
  const canOperate = useCan(role, "database", "operate");

  const run = useMutation({
    mutationFn: (action: Action) =>
      triggerDatabaseLifecycle({ data: { action, databaseId } }),
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
