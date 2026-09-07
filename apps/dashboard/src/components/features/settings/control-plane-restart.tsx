import { useMutation } from "@tanstack/react-query";
import { useCallback, useState } from "react";

import { ConfirmActionDialog } from "@/components/confirm-action-dialog";
import { Button } from "@/components/ui/button";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@/components/ui/frame";
import { toast } from "@/components/ui/toast";
import { errorMessage } from "@/lib/format";
import { restartControlPlane } from "@/server/control-plane";

export function ControlPlaneRestart({ canRun }: { canRun: boolean }) {
  const [confirming, setConfirming] = useState(false);

  const restart = useMutation({
    mutationFn: () => restartControlPlane(),
    onError: (error: Error) =>
      toast.add({
        description: errorMessage(error, "restart failed"),
        title: "Could not queue the restart",
        type: "error",
      }),
    onSuccess: () => {
      setConfirming(false);
      toast.add({ title: "Restart queued", type: "success" });
    },
  });

  const open = useCallback(() => setConfirming(true), []);
  const close = useCallback(() => setConfirming(false), []);
  const confirm = useCallback(() => restart.mutate(), [restart]);

  if (!canRun) {
    return null;
  }

  return (
    <Frame stacked variant="ghost">
      <FrameHeader className="flex-row items-start justify-between gap-3">
        <div className="flex flex-col gap-(--frame-panel-header-gap)">
          <FrameTitle>Restarting Noddle itself</FrameTitle>
          <FrameDescription>
            When the dashboard or the deploy queue stops responding.
          </FrameDescription>
        </div>
        <Button onClick={open} size="sm" variant="outline">
          Restart
        </Button>
      </FrameHeader>

      <FramePanel>
        <p className="text-muted-foreground text-xs">
          Restarts the dashboard and the worker. Postgres, Redis and Traefik
          keep running — you reached this page through them, so restarting them
          would take away the way back.
        </p>
      </FramePanel>

      <ConfirmActionDialog
        confirmLabel="Restart"
        description="The dashboard and the worker restart together. This page drops for a few seconds, and any deploy running right now is interrupted and retried."
        onConfirm={confirm}
        onOpenChange={close}
        open={confirming}
        pending={restart.isPending}
        title="Restart Noddle"
      />
    </Frame>
  );
}
