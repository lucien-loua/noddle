import { useMutation } from "@tanstack/react-query";
import { useCallback } from "react";

import { Button } from "@/components/ui/button";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@/components/ui/frame";
import { Spinner } from "@/components/ui/spinner";
import { errorMessage } from "@/lib/format";
import { runMaintenance } from "@/server/control-plane";

type Task = "prune-docker" | "prune-registry";

function TaskRow({
  description,
  label,
  onRun,
  pending,
  title,
}: {
  description: string;
  label: string;
  onRun: () => void;
  pending: boolean;
  title: string;
}) {
  return (
    <FramePanel className="flex flex-row items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="text-sm">{title}</p>
        <p className="text-muted-foreground text-xs">{description}</p>
      </div>
      <Button disabled={pending} onClick={onRun} size="sm" variant="outline">
        {pending ? <Spinner data-icon="inline-start" /> : null}
        {label}
      </Button>
    </FramePanel>
  );
}

export function Maintenance({ canRun }: { canRun: boolean }) {
  const run = useMutation({
    mutationFn: (task: Task) => runMaintenance({ data: { task } }),
  });

  const pruneDocker = useCallback(() => run.mutate("prune-docker"), [run]);
  const pruneRegistry = useCallback(() => run.mutate("prune-registry"), [run]);

  const queued = run.isSuccess ? run.variables : null;

  return (
    <Frame stacked variant="ghost">
      <FrameHeader>
        <FrameTitle>Disk</FrameTitle>
        <FrameDescription>
          Every build leaves something behind. Reclaim it here.
        </FrameDescription>
      </FrameHeader>

      {canRun ? (
        <TaskRow
          description="Stopped containers, dangling image layers and unused volumes accumulate after every build and stay until removed."
          label="Prune Docker"
          onRun={pruneDocker}
          pending={run.isPending && run.variables === "prune-docker"}
          title="Reclaim disk space"
        />
      ) : null}

      {canRun ? (
        <TaskRow
          description="An image tag nothing deploys still points at just sits in the registry. Rolling back to a purged tag rebuilds it instead."
          label="Prune registry"
          onRun={pruneRegistry}
          pending={run.isPending && run.variables === "prune-registry"}
          title="Delete unused image tags"
        />
      ) : null}

      {run.isError ? (
        <FramePanel>
          <p className="text-destructive text-sm" role="alert">
            {errorMessage(run.error, "could not queue the job")}
          </p>
        </FramePanel>
      ) : null}
      {queued ? (
        <FramePanel>
          <p className="text-muted-foreground text-sm">
            Queued. It runs once the deploy queue is free.
          </p>
        </FramePanel>
      ) : null}
    </Frame>
  );
}
