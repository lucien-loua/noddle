import { DATABASE_PORT } from "@noddle/database-spec";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { lazy, useCallback, useEffect, useState } from "react";

import { AppShell } from "@/components/app-shell";
import { DetailBreadcrumb } from "@/components/detail-breadcrumb";
import { DatabaseCredentials } from "@/components/features/database/database-credentials";
import { DatabaseExternal } from "@/components/features/database/database-external";
import { DatabaseHeaderActions } from "@/components/features/database/database-header-actions";
import { DatabaseStatusLine } from "@/components/features/database/database-status-line";
import { EnvVarPanel } from "@/components/features/env-vars/panel";
import { ResourceDetailFrame } from "@/components/resource-detail/resource-detail-frame";
import { TabRail } from "@/components/tab-rail";
import { useTerminalDialog } from "@/components/terminal-dialog";
import { Tabs, TabsContent, TabsTrigger } from "@/components/ui/tabs";
import type { LifecycleAction } from "@/components/use-lifecycle-actions";
import { cache } from "@/lib/cache";
import { roles } from "@/lib/permissions";
import type { RoleName } from "@/lib/permissions";
import { queries } from "@/lib/queries";
import { ActiveTabPanel } from "@/lib/resource-detail/active-tab";
import { resourceDetailBeforeLoad } from "@/lib/resource-detail/auth-before-load";
import { DETAIL_TAB_PANEL_CLASS } from "@/lib/resource-detail/constants";
import {
  isLifecycleSettled,
  lifecyclePollInterval,
} from "@/lib/resource-detail/lifecycle-poll";
import type { AwaitingLifecycle } from "@/lib/resource-detail/lifecycle-poll";
import { isDetailTab } from "@/lib/resource-detail/parse-tab";
import { useDetailTabChange } from "@/lib/resource-detail/use-detail-tab";
import { useLeaveOnDelete } from "@/lib/resource-detail/use-leave-on-delete";
import { useCan } from "@/lib/use-permission";
import { getDatabase } from "@/server/databases";

const BackupTab = lazy(() =>
  import("@/components/features/backups/backup-tab").then((m) => ({
    default: m.BackupTab,
  }))
);
const DatabaseAdvanced = lazy(() =>
  import("@/components/features/database/database-advanced").then((m) => ({
    default: m.DatabaseAdvanced,
  }))
);
const DatabaseLogs = lazy(() =>
  import("@/components/features/database/database-logs").then((m) => ({
    default: m.DatabaseLogs,
  }))
);
const DatabaseResources = lazy(() =>
  import("@/components/features/database/database-resources").then((m) => ({
    default: m.DatabaseResources,
  }))
);

const DATABASE_TABS = [
  "general",
  "env",
  "logs",
  "monitoring",
  "backups",
  "advanced",
] as const;

type DatabaseTab = (typeof DATABASE_TABS)[number];

interface DetailSearch {
  /** Active panel. Omitted when `general` so the default URL stays clean. */
  tab?: DatabaseTab;
}

function isDatabaseTab(value: unknown): value is DatabaseTab {
  return isDetailTab(value, DATABASE_TABS);
}

export const Route = createFileRoute(
  "/projects_/$projectId_/$environmentId_/databases/$databaseId"
)({
  beforeLoad: resourceDetailBeforeLoad,
  component: DatabaseDetail,
  loader: async ({ context, params }) => {
    const database = await getDatabase({
      data: { databaseId: params.databaseId },
    });
    if (!database) {
      throw notFound();
    }
    return {
      database,
      email: context.email,
      role: context.role,
    };
  },
  validateSearch: (search: Record<string, unknown>): DetailSearch => ({
    tab: isDatabaseTab(search.tab) ? search.tab : undefined,
  }),
});

function DatabaseDetail() {
  const { database: initialDatabase, email, role } = Route.useLoaderData();
  const navigate = Route.useNavigate();
  const search = Route.useSearch();
  const queryClient = useQueryClient();

  const [awaiting, setAwaiting] = useState<AwaitingLifecycle | null>(null);

  const databaseQuery = useQuery({
    ...queries.database(initialDatabase.id),
    initialData: initialDatabase,
    refetchInterval: (q) => {
      const row = q.state.data;
      return lifecyclePollInterval(row, awaiting, {
        forcePoll: row?.status === "deleting" || row?.status === "deploying",
      });
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

  const handleTabChange = useDetailTabChange<DatabaseTab>(navigate, "general");

  const [deleteError, setDeleteError] = useState<string | null>(null);

  const handleDeleted = useLeaveOnDelete({
    environmentId: database.environmentId,
    navigate,
    projectId: database.projectId,
    queryClient,
  });

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

  const handleEnvSaved = useCallback(() => handleDone("restart"), [handleDone]);

  return (
    <AppShell
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
      <ResourceDetailFrame
        deleteError={deleteError}
        subtitle={
          <DatabaseStatusLine
            database={database}
            pendingAction={awaiting?.action ?? null}
          />
        }
        teardownError={database.lastError}
      >
        <Tabs
          className="min-h-0 flex-1 gap-3"
          onValueChange={handleTabChange}
          value={tab}
        >
          <div className="flex shrink-0 flex-col gap-3">
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
          </div>

          <TabsContent className={DETAIL_TAB_PANEL_CLASS} value="general">
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
            <TabsContent className={DETAIL_TAB_PANEL_CLASS} value="env">
              <EnvVarPanel
                databaseId={database.id}
                effect={`Restarts ${database.name} once saved.`}
                note="Keys the engine owns are set by Noddle from this database's own settings and cannot be overridden here."
                onSaved={handleEnvSaved}
              />
            </TabsContent>
          ) : null}

          <TabsContent className={DETAIL_TAB_PANEL_CLASS} value="logs">
            <ActiveTabPanel active={tab} value="logs">
              <DatabaseLogs
                databaseId={database.id}
                databaseName={database.name}
                generation={`${database.status}:${database.updatedAt}`}
              />
            </ActiveTabPanel>
          </TabsContent>

          <TabsContent className={DETAIL_TAB_PANEL_CLASS} value="monitoring">
            <ActiveTabPanel active={tab} value="monitoring">
              <DatabaseResources databaseId={database.id} />
            </ActiveTabPanel>
          </TabsContent>

          {canEditConfig ? (
            <TabsContent className={DETAIL_TAB_PANEL_CLASS} value="advanced">
              <ActiveTabPanel active={tab} value="advanced">
                <DatabaseAdvanced canEdit={canEditConfig} database={database} />
              </ActiveTabPanel>
            </TabsContent>
          ) : null}

          <TabsContent className={DETAIL_TAB_PANEL_CLASS} value="backups">
            <ActiveTabPanel active={tab} value="backups">
              <BackupTab
                canCreate={canCreateBackup}
                canRestore={canRestoreBackup}
                defaultDatabaseName={database.databaseName ?? database.name}
                resourceName={database.name}
                subject={{ databaseId: database.id, kind: "database" }}
              />
            </ActiveTabPanel>
          </TabsContent>
        </Tabs>
      </ResourceDetailFrame>
      {terminal}
    </AppShell>
  );
}
