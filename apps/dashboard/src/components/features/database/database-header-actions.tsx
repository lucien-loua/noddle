import {
  ArrowClockwiseIcon,
  PlayIcon,
  StopIcon,
  TerminalIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import { useMutation } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import type { ReactNode } from "react";

import { ConfirmActionDialog } from "@/components/confirm-action-dialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useDeleteResourceAction } from "@/components/use-delete-resource-action";
import { errorMessage } from "@/lib/format";
import type { RoleName } from "@/lib/permissions";
import type { ResourceActions } from "@/lib/resource-actions/use-resource-actions";
import { databaseRow } from "@/lib/scope-rows";
import type { DatabaseRow } from "@/server/databases";

type ConfirmKind = "restart" | "start" | "stop";

const CONFIRM_COPY: Record<
  ConfirmKind,
  { confirmLabel: string; description: string; title: string }
> = {
  restart: {
    confirmLabel: "Restart",
    description:
      "The container is stopped and started again. The data is untouched.",
    title: "Restart this database?",
  },
  start: {
    confirmLabel: "Start",
    description: "The database starts again on its existing data.",
    title: "Start this database?",
  },
  stop: {
    confirmLabel: "Stop",
    description:
      "Connected applications lose access until it is started again. Nothing is deleted.",
    title: "Stop this database?",
  },
};

function DatabaseActionsToolbar({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>;
}

export function DatabaseHeaderActions({
  actions,
  database,
  known,
  onDeleted,
  onDone,
  onError,
  onTerminal,
}: {
  actions: ResourceActions;
  database: DatabaseRow;
  known: RoleName | null;
  onDeleted: () => void;
  onDone: () => Promise<void> | void;
  onError: (message: string) => void;
  onTerminal: (() => void) | null;
}) {
  const [confirm, setConfirm] = useState<ConfirmKind | null>(null);

  const target = useMemo(() => databaseRow(database), [database]);
  const available = actions.actionsFor(target);
  const status = actions.statusOf(target);
  const stopped = database.status === "stopped";

  const lifecycle = useMutation({
    mutationFn: (action: "restart" | "start" | "stop") =>
      actions.run(target, action),
    onError: (e: Error) => onError(errorMessage(e, "the action was refused")),
    onSuccess: () => onDone(),
  });

  const runDelete = useCallback(
    (confirmName: string) => actions.run(target, "delete", { confirmName }),
    [actions, target]
  );
  const del = useDeleteResourceAction({
    id: target.id,
    kind: "database",
    name: target.name,
    onDeleted,
    onError,
    role: known,
    run: runDelete,
  });

  const pending = status.tone === "busy";
  const actionsBusy = lifecycle.isPending || pending;
  const showLifecycle = available.has("start") || available.has("stop");
  const showRestart = available.has("restart");

  const closeConfirm = useCallback((open: boolean) => {
    if (!open) {
      setConfirm(null);
    }
  }, []);

  const requestRestart = useCallback(() => setConfirm("restart"), []);
  const requestStartStop = useCallback(
    () => setConfirm(stopped ? "start" : "stop"),
    [stopped]
  );

  const handleConfirmed = useCallback(() => {
    const kind = confirm;
    setConfirm(null);
    if (kind === "restart") {
      lifecycle.mutate("restart");
      return;
    }
    lifecycle.mutate(stopped ? "start" : "stop");
  }, [confirm, lifecycle, stopped]);

  const copy = confirm ? CONFIRM_COPY[confirm] : null;

  if (!(showLifecycle || del.canDelete || onTerminal)) {
    return null;
  }

  return (
    <>
      <DatabaseActionsToolbar>
        {showLifecycle && showRestart ? (
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
            variant={stopped ? "outline" : "destructive"}
          >
            {stopped ? (
              <PlayIcon data-icon="inline-start" weight="fill" />
            ) : (
              <StopIcon data-icon="inline-start" weight="fill" />
            )}
            {stopped ? "Start" : "Stop"}
          </Button>
        ) : null}

        {onTerminal ? (
          <Button onClick={onTerminal} variant="outline">
            <TerminalIcon data-icon="inline-start" weight="regular" />
            Open terminal
          </Button>
        ) : null}

        {del.canDelete ? (
          <Button onClick={del.handleOpen} variant="outline">
            <TrashIcon data-icon="inline-start" weight="regular" />
            Delete
          </Button>
        ) : null}

        {pending ? <Spinner className="text-muted-foreground" /> : null}
      </DatabaseActionsToolbar>

      {copy ? (
        <ConfirmActionDialog
          confirmLabel={copy.confirmLabel}
          description={copy.description}
          onConfirm={handleConfirmed}
          onOpenChange={closeConfirm}
          open
          pending={lifecycle.isPending}
          title={copy.title}
        />
      ) : null}

      {del.canDelete ? del.dialog : null}
    </>
  );
}
