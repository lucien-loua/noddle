import {
  DATABASE_ENGINE_LABEL,
  DATABASE_PORT,
} from "@noddle/shared/database-engines";
import {
  ArrowClockwiseIcon,
  CaretDownIcon,
  PlayIcon,
  StopIcon,
  TerminalIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { useDeleteDatabaseAction } from "@/components/delete-database-action";
import { DetailBreadcrumb } from "@/components/detail-breadcrumb";
import { BackupPanel } from "@/components/features/backups/panel";
import { RestoreDialog } from "@/components/features/backups/restore-dialog";
import type { RestoreTarget } from "@/components/features/backups/types";
import { DatabaseAdvanced } from "@/components/features/database/database-advanced";
import { DatabaseCredentials } from "@/components/features/database/database-credentials";
import { DatabaseExternal } from "@/components/features/database/database-external";
import { DatabaseLogs } from "@/components/features/database/database-logs";
import { DatabaseMark } from "@/components/features/database/database-mark";
import { DatabaseResources } from "@/components/features/database/database-resources";
import { EnvVarPanel } from "@/components/features/env-vars/panel";
import { TabRail } from "@/components/tab-rail";
import { TeardownError } from "@/components/teardown-error";
import { useTerminalDialog } from "@/components/terminal-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
import { Tabs, TabsContent, TabsTrigger } from "@/components/ui/tabs";
import {
  type LifecycleAction,
  useLifecycleActions,
} from "@/components/use-lifecycle-actions";
import { cache } from "@/lib/cache";
import { serviceLabel } from "@/lib/format";
import { type RoleName, roles } from "@/lib/permissions";
import { queries } from "@/lib/queries";
import { useCan } from "@/lib/use-permission";
import { getAuthState } from "@/server/auth";
import { getDestinations, triggerRestore } from "@/server/backups";
import { type DatabaseRow, getDatabase } from "@/server/databases";

/**
 * The panel scrolls on its own: it's the page that stays fixed. The same as
 * a service page's, and the two additions compared to its earlier form are
 * the ones this file already documents:
 *
 *   `-mx-2 px-2`              `overflow-y-auto` CLIPS the focus ring of the
 *                             first and last fields; the negative margin
 *                             gives back the space without shifting a pixel.
 *   `data-ending-style:hidden` Base UI keeps the OUTGOING panel mounted for
 *                             the duration of its transition. Without its
 *                             own height that wasn't visible — since panels
 *                             now stretch with `flex-1`, the old content
 *                             would keep its place and push the new one off
 *                             screen.
 */
const TAB_PANEL =
  "scroll-fade no-scrollbar -mx-2 mt-3 min-h-0 flex-1 overflow-y-auto px-2 data-ending-style:hidden";

const DATABASE_TABS = [
  "general",
  "env",
  "logs",
  "monitoring",
  "backups",
  "advanced",
] as const;

const DETAIL_POLL_MS = 2000;
const AWAITING_TIMEOUT_MS = 60_000;

const PENDING_LABEL: Record<LifecycleAction, string> = {
  restart: "Restarting",
  start: "Starting",
  stop: "Stopping",
};

interface AwaitingLifecycle {
  action: LifecycleAction;
  since: number;
  status: string;
  updatedAt: string;
}

function isLifecycleSettled(
  database: DatabaseRow,
  awaiting: AwaitingLifecycle
): boolean {
  if (Date.now() - awaiting.since > AWAITING_TIMEOUT_MS) {
    return true;
  }
  // Restart stays `running`: the worker bumps `updatedAt` when Swarm
  // accepted the force-update. Start/stop move `status`.
  if (awaiting.action === "restart") {
    return database.updatedAt !== awaiting.updatedAt;
  }
  return database.status !== awaiting.status;
}

type DatabaseTab = (typeof DATABASE_TABS)[number];

interface DetailSearch {
  /** Active panel. Omitted when `general` so the default URL stays clean. */
  tab?: DatabaseTab;
}

function isDatabaseTab(value: unknown): value is DatabaseTab {
  return (
    typeof value === "string" &&
    (DATABASE_TABS as readonly string[]).includes(value)
  );
}

export const Route = createFileRoute(
  "/projects_/$projectId_/$environmentId_/databases/$databaseId"
)({
  beforeLoad: async () => {
    const state = await getAuthState();
    if (!state.signedIn) {
      throw redirect({ to: "/login" });
    }
    return { email: state.email, role: state.role };
  },
  component: DatabaseDetail,
  loader: async ({ context, params }) => {
    const [database, destinations] = await Promise.all([
      getDatabase({ data: { databaseId: params.databaseId } }),
      getDestinations(),
    ]);
    if (!database) {
      throw notFound();
    }
    return {
      database,
      destinations,
      email: context.email,
      role: context.role,
    };
  },
  validateSearch: (search: Record<string, unknown>): DetailSearch => ({
    tab: isDatabaseTab(search.tab) ? search.tab : undefined,
  }),
});

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
function DatabaseHeaderActions({
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
  const pending = pendingAction !== null;
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

function DatabaseDetail() {
  const {
    database: initialDatabase,
    destinations,
    email,
    role,
  } = Route.useLoaderData();
  const navigate = Route.useNavigate();
  const search = Route.useSearch();
  const queryClient = useQueryClient();

  const [awaiting, setAwaiting] = useState<AwaitingLifecycle | null>(null);

  const databaseQuery = useQuery({
    ...queries.database(initialDatabase.id),
    initialData: initialDatabase,
    refetchInterval: (q) => {
      const row = q.state.data;
      if (!row) {
        return false;
      }
      if (row.status === "deleting") {
        return DETAIL_POLL_MS;
      }
      if (!awaiting) {
        return false;
      }
      return isLifecycleSettled(row, awaiting) ? false : DETAIL_POLL_MS;
    },
  });
  const database = databaseQuery.data ?? initialDatabase;

  useEffect(() => {
    if (!awaiting) {
      return;
    }
    if (isLifecycleSettled(database, awaiting)) {
      setAwaiting(null);
    }
  }, [awaiting, database]);

  const known: RoleName | null =
    role && role in roles ? (role as RoleName) : null;
  const canCreateBackup = useCan(known, "backup", "create");
  const canRestoreBackup = useCan(known, "backup", "restore");
  // `envVar: read` and not `database: read`: this is the "read production
  // secrets" boundary, so `viewer` is excluded from it.
  const canReadSecrets = useCan(known, "envVar", "read");
  // `create` and not `operate`: publishing a port is a CONFIGURATION change
  // that opens up the database, not an action on what's running.
  const canEditConfig = useCan(known, "database", "create");
  const canShell = useCan(known, "container", "shell");
  const { openTerminal, terminal } = useTerminalDialog();

  const requestedTab = search.tab ?? "general";
  const tab =
    (requestedTab === "env" && !canReadSecrets) ||
    (requestedTab === "advanced" && !canEditConfig)
      ? "general"
      : requestedTab;

  const handleTabChange = useCallback<(value: DatabaseTab) => void>(
    (value) =>
      navigate({
        replace: true,
        search: { tab: value === "general" ? undefined : value },
      }),
    [navigate]
  );

  const [restoreTarget, setRestoreTarget] = useState<RestoreTarget | null>(
    null
  );
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const restore = useMutation({
    mutationFn: (confirmName: string) => {
      if (!restoreTarget) {
        throw new Error("no restore target");
      }
      if (restoreTarget.kind === "run") {
        return triggerRestore({
          data: {
            backupId: restoreTarget.backup.id,
            confirmName,
            databaseId: database.id,
          },
        });
      }
      return triggerRestore({
        data: {
          confirmName,
          databaseId: database.id,
          destinationId: restoreTarget.destinationId,
          objectKey: restoreTarget.objectKey,
        },
      });
    },
    onSuccess: () => setRestoreTarget(null),
  });

  const handleClose = useCallback((open: boolean) => {
    if (!open) {
      setRestoreTarget(null);
    }
  }, []);
  const handleConfirm = useCallback(
    (confirmName: string) => restore.mutate(confirmName),
    [restore]
  );

  // We LEAVE the page once the teardown has started, as for a service: the
  // database is disappearing, staying on it would show a detail view
  // emptying itself out.
  const handleDeleted = useCallback(async () => {
    await cache.environmentScope(
      queryClient,
      database.projectId,
      database.environmentId
    );
    await navigate({
      params: {
        environmentId: database.environmentId,
        projectId: database.projectId,
      },
      to: "/projects/$projectId/$environmentId",
    });
  }, [database.environmentId, database.projectId, navigate, queryClient]);

  const handleDone = useCallback(
    async (action: LifecycleAction) => {
      // Snapshot at enqueue: the Job writes later. Restart doesn't move
      // `status`, so we also snapshot `updatedAt` and wait for that bump.
      setAwaiting({
        action,
        since: Date.now(),
        status: database.status,
        updatedAt: database.updatedAt,
      });
      await cache.database(queryClient, database.id);
      await cache.environmentScope(
        queryClient,
        database.projectId,
        database.environmentId
      );
    },
    [
      database.environmentId,
      database.id,
      database.projectId,
      database.status,
      database.updatedAt,
      queryClient,
    ]
  );

  return (
    <AppShell
      actions={
        <DatabaseHeaderActions
          database={database}
          known={known}
          onDeleted={handleDeleted}
          onDone={handleDone}
          onError={setDeleteError}
          onTerminal={
            canShell
              ? () =>
                  openTerminal({
                    id: database.id,
                    kind: "container",
                    target: "database",
                    title: database.name,
                  })
              : null
          }
          pendingAction={awaiting?.action ?? null}
        />
      }
      breadcrumb={
        <DetailBreadcrumb
          environment={database.environment}
          name={database.name}
          // The parent is the ENVIRONMENT, not a global screen: it's where
          // you come from and where the resource is listed.
          parent={{
            environmentId: database.environmentId,
            label: database.environment,
            projectId: database.projectId,
            to: "/projects/$projectId/$environmentId",
          }}
          project={database.project}
        />
      }
      email={email}
      role={role}
      title={database.name}
    >
      <div className="flex h-full min-h-0 flex-col">
        <p className="mb-3 flex items-center gap-2 truncate text-muted-foreground text-sm">
          <DatabaseMark engine={database.engine} />
          {DATABASE_ENGINE_LABEL[database.engine] ?? database.engine} ·{" "}
          {database.serverName}
        </p>
        <TeardownError message={database.lastError} />
        {deleteError ? (
          <Alert className="mb-3" variant="destructive">
            <AlertDescription>{deleteError}</AlertDescription>
          </Alert>
        ) : null}

        <Tabs
          className="min-h-0 flex-1"
          onValueChange={handleTabChange}
          value={tab}
        >
          <TabRail>
            <TabsTrigger value="general">General</TabsTrigger>
            {canReadSecrets ? (
              <TabsTrigger value="env">Environment</TabsTrigger>
            ) : null}
            <TabsTrigger value="logs">Logs</TabsTrigger>
            <TabsTrigger value="monitoring">Monitoring</TabsTrigger>
            <TabsTrigger value="backups">Backups</TabsTrigger>
            {canEditConfig ? (
              <TabsTrigger value="advanced">Advanced</TabsTrigger>
            ) : null}
          </TabRail>

          <TabsContent className={TAB_PANEL} value="general">
            <DatabaseCredentials
              canChangePassword={canEditConfig}
              canRead={canReadSecrets}
              databaseId={database.id}
              databaseName={database.name}
              running={database.status === "running"}
            />
            <DatabaseExternal
              canEdit={canEditConfig}
              canReadSecrets={canReadSecrets}
              databaseId={database.id}
              defaultPort={DATABASE_PORT[database.engine]}
              externalPort={database.externalPort}
            />
          </TabsContent>

          {canReadSecrets ? (
            <TabsContent className={TAB_PANEL} value="env">
              <EnvVarPanel
                databaseId={database.id}
                effect={`Restarts ${database.name} once saved.`}
                note={`Saving restarts ${database.name}. Keys the engine owns are set by Noddle from this database's own settings and cannot be overridden here.`}
              />
            </TabsContent>
          ) : null}

          <TabsContent className={TAB_PANEL} value="logs">
            <DatabaseLogs
              databaseId={database.id}
              databaseName={database.name}
              generation={`${database.status}:${database.updatedAt}`}
            />
          </TabsContent>

          <TabsContent className={TAB_PANEL} value="monitoring">
            <DatabaseResources databaseId={database.id} />
          </TabsContent>

          {canEditConfig ? (
            <TabsContent className={TAB_PANEL} value="advanced">
              <DatabaseAdvanced canEdit={canEditConfig} database={database} />
            </TabsContent>
          ) : null}

          <TabsContent className={TAB_PANEL} value="backups">
            <BackupPanel
              canCreate={canCreateBackup}
              canRestore={canRestoreBackup}
              databaseId={database.id}
              databaseName={database.name}
              defaultDatabaseName={database.databaseName ?? database.name}
              destinations={destinations}
              onRestore={setRestoreTarget}
            />
            {restore.isError ? (
              <Alert className="mt-3" variant="destructive">
                <AlertDescription>
                  {restore.error instanceof Error
                    ? restore.error.message
                    : "restore refused"}
                </AlertDescription>
              </Alert>
            ) : null}
          </TabsContent>
        </Tabs>

        <RestoreDialog
          databaseName={database.name}
          onConfirm={handleConfirm}
          onOpenChange={handleClose}
          pending={restore.isPending}
          target={restoreTarget}
        />
      </div>
      {terminal}
    </AppShell>
  );
}
