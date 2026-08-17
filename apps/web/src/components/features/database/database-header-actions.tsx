import {
  ArrowClockwiseIcon,
  PlayIcon,
  StopIcon,
  TerminalIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import { useCallback, useState } from "react";
import type { ReactNode } from "react";

import { ConfirmActionDialog } from "@/components/confirm-action-dialog";
import { useDeleteDatabaseAction } from "@/components/delete-database-action";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useLifecycleActions } from "@/components/use-lifecycle-actions";
import type { LifecycleAction } from "@/components/use-lifecycle-actions";
import type { RoleName } from "@/lib/permissions";
import type { DatabaseRow } from "@/server/databases";

type ConfirmKind = "restart" | "start" | "stop";

const CONFIRM_COPY: Record<
  ConfirmKind,
  { description: string; title: string }
> = {
  restart: {
    description:
      "Are you sure you want to restart this database? The container is stopped and started again without changing its data.",
    title: "Restart",
  },
  start: {
    description: "Are you sure you want to start this database?",
    title: "Start",
  },
  stop: {
    description:
      "Are you sure you want to stop this database? Connected applications will lose access until it is started again.",
    title: "Stop",
  },
};

function DatabaseActionsToolbar({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>;
}

/**
 * Database action bar — same shape as `ServiceDeploySettings`: flat buttons
 * composed into a toolbar, not a status chip glued to a dropdown.
 */
export function DatabaseHeaderActions({
  database,
  known,
  onDeleted,
  onDone,
  onError,
  onTerminal,
  pendingAction,
}: {
  database: DatabaseRow;
  known: RoleName | null;
  onDeleted: () => void;
  onDone: (action: LifecycleAction) => void;
  onError: (message: string) => void;
  onTerminal: (() => void) | null;
  pendingAction: LifecycleAction | null;
}) {
  const [confirm, setConfirm] = useState<ConfirmKind | null>(null);

  const lifecycle = useLifecycleActions({
    onDone,
    onError,
    role: known,
    status: database.status,
    target: { databaseId: database.id, resource: "database" },
  });
  const del = useDeleteDatabaseAction({
    databaseId: database.id,
    databaseName: database.name,
    onDeleted,
    onError,
    role: known,
  });

  const pending = pendingAction !== null || database.status === "deploying";
  const actionsBusy = lifecycle.busy || pending;
  const showLifecycle = lifecycle.available;

  const closeConfirm = useCallback((open: boolean) => {
    if (!open) {
      setConfirm(null);
    }
  }, []);

  const requestRestart = useCallback(() => setConfirm("restart"), []);
  const requestStartStop = useCallback(
    () => setConfirm(lifecycle.stopped ? "start" : "stop"),
    [lifecycle.stopped]
  );

  const handleConfirmed = useCallback(() => {
    const kind = confirm;
    setConfirm(null);
    if (kind === "restart") {
      lifecycle.handleRestart();
      return;
    }
    lifecycle.handleStopStart();
  }, [confirm, lifecycle]);

  const copy = confirm ? CONFIRM_COPY[confirm] : null;

  if (!(showLifecycle || del.canDelete || onTerminal)) {
    return null;
  }

  return (
    <>
      <DatabaseActionsToolbar>
        {showLifecycle && lifecycle.showRestart ? (
          <Button
            disabled={actionsBusy}
            onClick={requestRestart}
            variant="outline"
          >
            <ArrowClockwiseIcon data-icon="inline-start" weight="fill" />
            Restart
          </Button>
        ) : null}

        {showLifecycle ? (
          <Button
            disabled={actionsBusy}
            onClick={requestStartStop}
            variant={lifecycle.stopped ? "outline" : "destructive"}
          >
            {lifecycle.stopped ? (
              <PlayIcon data-icon="inline-start" weight="fill" />
            ) : (
              <StopIcon data-icon="inline-start" weight="fill" />
            )}
            {lifecycle.stopped ? "Start" : "Stop"}
          </Button>
        ) : null}

        {onTerminal ? (
          <Button onClick={onTerminal} variant="outline">
            <TerminalIcon data-icon="inline-start" weight="regular" />
            Open Terminal
          </Button>
        ) : null}

        {del.canDelete ? (
          <Button onClick={del.handleOpen} variant="outline">
            <TrashIcon data-icon="inline-start" />
            Delete
          </Button>
        ) : null}

        {pending ? <Spinner className="text-muted-foreground" /> : null}
      </DatabaseActionsToolbar>

      {copy ? (
        <ConfirmActionDialog
          description={copy.description}
          onConfirm={handleConfirmed}
          onOpenChange={closeConfirm}
          open
          pending={lifecycle.busy}
          title={copy.title}
        />
      ) : null}

      {del.canDelete ? del.dialog : null}
    </>
  );
}
