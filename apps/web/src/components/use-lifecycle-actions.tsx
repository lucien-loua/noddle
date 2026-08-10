import { useMutation } from "@tanstack/react-query";
import { useCallback } from "react";
import { errorMessage } from "@/lib/format";
import type { RoleName } from "@/lib/permissions";
import { useCan } from "@/lib/use-permission";
import { triggerLifecycle } from "@/server/deployments";

type Action = "restart" | "start" | "stop";

export function useLifecycleActions({
  onDone,
  onError,
  role,
  serviceId,
  status,
}: {
  onDone: () => void;
  onError: (message: string) => void;
  role: RoleName | null;
  serviceId: string;
  status: string;
}) {
  const canOperate = useCan(role, "service", "deploy");

  const run = useMutation({
    mutationFn: (action: Action) =>
      triggerLifecycle({ data: { action, serviceId } }),
    onError: (e: Error) => onError(errorMessage(e, "action refused")),
    onSuccess: onDone,
  });

  const stop = useCallback(() => run.mutate("stop"), [run]);
  const start = useCallback(() => run.mutate("start"), [run]);
  const restart = useCallback(() => run.mutate("restart"), [run]);

  const stopped = status === "stopped";
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
