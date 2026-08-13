import {
  ArrowClockwiseIcon,
  CaretDownIcon,
  PlayIcon,
  StopIcon,
  TerminalIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import { useDeleteDatabaseAction } from "@/components/delete-database-action";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ButtonGroup, ButtonGroupText } from "@/components/ui/button-group";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import {
  type LifecycleAction,
  useLifecycleActions,
} from "@/components/use-lifecycle-actions";
import { serviceLabel } from "@/lib/format";
import type { RoleName } from "@/lib/permissions";
import type { DatabaseRow } from "@/server/databases";

const PENDING_LABEL: Record<LifecycleAction, string> = {
  restart: "Restarting",
  start: "Starting",
  stop: "Stopping",
};

/**
 * A database's action bar — the SAME as a service's.
 *
 * It used to be a status `Badge` followed by three loose buttons (Stop,
 * Restart, Delete), while a service's page carries a `ButtonGroup`: the
 * status glued to a single trigger, and the actions in its menu. Two
 * screens doing the same thing shouldn't present it in two different ways.
 *
 * The branch with no lifecycle (a database never provisioned, or being torn
 * down) keeps the Delete button in plain sight rather than a one-entry menu.
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

  const status = serviceLabel(database.status);
  const pending = pendingAction !== null || database.status === "deploying";
  const headerLabel = pendingAction
    ? PENDING_LABEL[pendingAction]
    : status.label;
  const actionsBusy = lifecycle.busy || pending;

  if (!(lifecycle.available || del.canDelete || onTerminal)) {
    return <Badge variant="outline">{headerLabel}</Badge>;
  }

  if (!lifecycle.available) {
    return (
      <>
        <ButtonGroup>
          <ButtonGroupText>
            {pending ? <Spinner /> : null}
            {headerLabel}
          </ButtonGroupText>
          {onTerminal ? (
            <Button onClick={onTerminal} variant="outline">
              <TerminalIcon weight="bold" />
              Terminal
            </Button>
          ) : null}
          <Button onClick={del.handleOpen} variant="outline">
            Delete
          </Button>
        </ButtonGroup>
        {del.dialog}
      </>
    );
  }

  return (
    <>
      <ButtonGroup>
        <ButtonGroupText>
          {pending ? <Spinner /> : null}
          {headerLabel}
        </ButtonGroupText>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                aria-label={`Actions for ${database.name}`}
                size="icon"
                variant="outline"
              >
                <CaretDownIcon weight="bold" />
              </Button>
            }
          />
          <DropdownMenuContent align="end">
            {onTerminal ? (
              <DropdownMenuItem onClick={onTerminal}>
                <TerminalIcon weight="bold" />
                Terminal
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem
              disabled={actionsBusy}
              onClick={lifecycle.handleStopStart}
            >
              {lifecycle.stopped ? (
                <PlayIcon weight="fill" />
              ) : (
                <StopIcon weight="fill" />
              )}
              {lifecycle.stopped ? "Start" : "Stop"}
            </DropdownMenuItem>
            {lifecycle.showRestart ? (
              <DropdownMenuItem
                disabled={actionsBusy}
                onClick={lifecycle.handleRestart}
              >
                <ArrowClockwiseIcon weight="fill" />
                Restart
              </DropdownMenuItem>
            ) : null}
            {del.canDelete ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={del.handleOpen}
                  variant="destructive"
                >
                  <TrashIcon />
                  Delete
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </ButtonGroup>

      {del.canDelete ? del.dialog : null}
    </>
  );
}
