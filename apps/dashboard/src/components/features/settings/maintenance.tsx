import { useMutation, useQuery } from "@tanstack/react-query";
import { useCallback, useState } from "react";

import { ContainerDrawer } from "@/components/features/containers/container-drawer";
import { Badge } from "@/components/ui/badge";
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
import { queries } from "@/lib/queries";
import type { ContainerRow } from "@/server/containers";
import { reloadWebServer, runMaintenance } from "@/server/control-plane";

type Task = "prune-docker" | "prune-registry";

function ContainerRowPanel({
  onOpenLogs,
  row,
}: {
  onOpenLogs: (row: ContainerRow) => void;
  row: ContainerRow;
}) {
  const handleOpen = useCallback(() => onOpenLogs(row), [onOpenLogs, row]);
  return (
    <FramePanel className="flex flex-row items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate font-mono text-xs">{row.name}</span>
        <Badge variant="outline">{row.state}</Badge>
      </div>
      <Button onClick={handleOpen} size="sm" variant="outline">
        View logs
      </Button>
    </FramePanel>
  );
}

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
  const containers = useQuery(queries.containers());
  const [open, setOpen] = useState<ContainerRow | null>(null);
  const reload = useMutation({ mutationFn: () => reloadWebServer() });
  const run = useMutation({
    mutationFn: (task: Task) => runMaintenance({ data: { task } }),
  });

  const handleReload = useCallback(() => reload.mutate(), [reload]);
  const pruneDocker = useCallback(() => run.mutate("prune-docker"), [run]);
  const pruneRegistry = useCallback(() => run.mutate("prune-registry"), [run]);
  const handleClose = useCallback((isOpen: boolean) => {
    if (!isOpen) {
      setOpen(null);
    }
  }, []);

  const rows = (containers.data?.containers ?? []).filter(
    (c) => c.kind === "control-plane"
  );
  const queued = run.isSuccess ? run.variables : null;

  return (
    <>
      <Frame stacked variant="ghost">
        <FrameHeader className="flex-row items-start justify-between gap-3">
          <div className="flex flex-col gap-(--frame-panel-header-gap)">
            <FrameTitle>Web server</FrameTitle>
            <FrameDescription>
              The control plane&apos;s own containers, on the machine it runs
              on.
            </FrameDescription>
          </div>
          <Button
            disabled={reload.isPending}
            onClick={handleReload}
            size="sm"
            variant="outline"
          >
            {reload.isPending ? <Spinner data-icon="inline-start" /> : null}
            Reload
          </Button>
        </FrameHeader>

        {containers.isPending ? (
          <FramePanel>
            <Spinner />
          </FramePanel>
        ) : null}

        {!containers.isPending && rows.length === 0 ? (
          <FramePanel>
            <p className="text-muted-foreground text-sm">
              Nothing found — is the server that runs this Noddle connected?
            </p>
          </FramePanel>
        ) : null}

        {rows.map((row) => (
          <ContainerRowPanel key={row.id} onOpenLogs={setOpen} row={row} />
        ))}

        {reload.isError ? (
          <FramePanel>
            <p className="text-destructive text-sm" role="alert">
              {errorMessage(reload.error, "could not queue the reload")}
            </p>
          </FramePanel>
        ) : null}
        {reload.isSuccess ? (
          <FramePanel>
            <p className="text-muted-foreground text-sm">
              Reload queued — running <code>docker compose restart</code> on the
              host. This page may drop for a few seconds.
            </p>
          </FramePanel>
        ) : null}
      </Frame>

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

      <ContainerDrawer onOpenChange={handleClose} row={open} />
    </>
  );
}
