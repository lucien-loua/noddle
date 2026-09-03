import { DATABASE_PORT } from "@noddle/shared/database-spec";
import { isTerminalStatus } from "@noddle/shared/logs";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { lazy, useCallback, useMemo, useRef, useState } from "react";

import { AppShell } from "@/components/app-shell";
import { DetailBreadcrumb } from "@/components/detail-breadcrumb";
import { DatabaseAttachments } from "@/components/features/database/database-attachments";
import { DatabaseCredentials } from "@/components/features/database/database-credentials";
import { DatabaseExternal } from "@/components/features/database/database-external";
import { DatabaseHeaderActions } from "@/components/features/database/database-header-actions";
import { DatabaseProvisionDrawer } from "@/components/features/database/database-provision-drawer";
import { DatabaseStatusLine } from "@/components/features/database/database-status-line";
import { EnvVarPanel } from "@/components/features/env-vars/panel";
import { ResourceDetailFrame } from "@/components/resource-detail/resource-detail-frame";
import { TabRail } from "@/components/tab-rail";
import { useTerminalDialog } from "@/components/terminal-dialog";
import { Tabs, TabsTrigger } from "@/components/ui/tabs";
import { cache } from "@/lib/cache";
import { roles } from "@/lib/permissions";
import type { RoleName } from "@/lib/permissions";
import { queries } from "@/lib/queries";
import { useResourceActions } from "@/lib/resource-actions/use-resource-actions";
import {
  DetailTabContent,
  isDetailTab,
  resourceDetailBeforeLoad,
  useDetailPage,
} from "@/lib/resource-detail/detail-page";
import { databaseRow } from "@/lib/scope-rows";
import { useCan } from "@/lib/use-permission";
import { getEnvironmentScope } from "@/server/dashboard";
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
  deployment?: string;
  tab?: DatabaseTab;
}

function isDatabaseTab(value: unknown): value is DatabaseTab {
  return isDetailTab(value, DATABASE_TABS);
}

export const Route = createFileRoute(
  "/projects_/$projectId_/$environmentId_/databases/$databaseId"
)({
  validateSearch: (search: Record<string, unknown>): DetailSearch => ({
    deployment:
      typeof search.deployment === "string" ? search.deployment : undefined,
    tab: isDatabaseTab(search.tab) ? search.tab : undefined,
  }),
  beforeLoad: resourceDetailBeforeLoad,
  component: DatabaseDetail,
  loader: async ({ context, params }) => {
    const [database, scope] = await Promise.all([
      getDatabase({ data: { databaseId: params.databaseId } }),
      getEnvironmentScope({
        data: {
          environmentId: params.environmentId,
          projectId: params.projectId,
        },
      }),
    ]);
    if (!database) {
      throw notFound();
    }
    return {
      database,
      email: context.email,
      role: context.role,
      services: scope.services,
    };
  },
});

function DatabaseDetail() {
  const {
    database: initialDatabase,
    email,
    role,
    services,
  } = Route.useLoaderData();
  const navigate = Route.useNavigate();
  const search = Route.useSearch();
  const queryClient = useQueryClient();

  const pollIntervalRef = useRef<false | number>(false);
  const databaseQuery = useQuery({
    ...queries.database(initialDatabase.id),
    initialData: initialDatabase,
    refetchInterval: () => pollIntervalRef.current,
  });
  const database = databaseQuery.data ?? initialDatabase;

  const target = useMemo(() => databaseRow(database), [database]);
  const known: RoleName | null =
    role && role in roles ? (role as RoleName) : null;
  const actions = useResourceActions([target], known);
  pollIntervalRef.current = actions.pollInterval;

  const canCreateBackup = useCan(known, "backup", "create");
  const canRestoreBackup = useCan(known, "backup", "restore");
  const canReadSecrets = useCan(known, "envVar", "read");
  const canEditConfig = useCan(known, "database", "create");
  const canAttach = useCan(known, "database", "attach");
  const canShell = useCan(known, "container", "shell");
  const { openTerminal, terminal } = useTerminalDialog();

  const requestedTab = search.tab ?? "general";
  const tab =
    (requestedTab === "env" && !canReadSecrets) ||
    (requestedTab === "advanced" && !canEditConfig)
      ? "general"
      : requestedTab;

  const [deleteError, setDeleteError] = useState<string | null>(null);

  const deployments = useQuery({
    ...queries.databaseDeployments(database.id),
    refetchInterval: (query) => {
      const latest = query.state.data?.[0];
      return latest && !isTerminalStatus(latest.status) ? 1500 : 5000;
    },
  });

  const showDeploymentLog = useCallback(
    (deploymentId: string) => {
      navigate({ search: (prev) => ({ ...prev, deployment: deploymentId }) });
    },
    [navigate]
  );

  const shownLogId = search.deployment ?? null;
  const focusedLog =
    deployments.data?.find((row) => row.id === shownLogId) ?? null;

  const { handleDeleted, handleTabChange } = useDetailPage<DatabaseTab>({
    defaultTab: "general",
    environmentId: database.environmentId,
    navigate,
    projectId: database.projectId,
    queryClient,
  });

  const handleDone = useCallback(async () => {
    await cache.database(queryClient, database.id);
    await cache.environmentScope(
      queryClient,
      database.projectId,
      database.environmentId
    );
  }, [database.environmentId, database.id, database.projectId, queryClient]);

  const handleEnvSaved = useCallback(() => handleDone(), [handleDone]);

  return (
    <AppShell
      breadcrumb={
        <DetailBreadcrumb
          environment={database.environment}
          name={database.name}
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
            status={actions.statusOf(target)}
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
              actions={actions}
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
            />
          </div>

          <DetailTabContent active={tab} value="general">
            <DatabaseCredentials
              canChangePassword={canEditConfig}
              canRead={canReadSecrets}
              databaseId={database.id}
              databaseName={database.name}
              running={database.status === "running"}
            />
            <DatabaseAttachments
              canAttach={canAttach}
              databaseId={database.id}
              engine={database.engine}
              services={services}
            />
            <DatabaseExternal
              canEdit={canEditConfig}
              canReadSecrets={canReadSecrets}
              databaseId={database.id}
              defaultPort={DATABASE_PORT[database.engine]}
              externalPort={database.externalPort}
            />
          </DetailTabContent>

          {canReadSecrets ? (
            <DetailTabContent active={tab} value="env">
              <EnvVarPanel
                databaseId={database.id}
                effect={`Restarts ${database.name} once saved.`}
                note="Keys the engine owns are set by Noddle from this database's own settings and cannot be overridden here."
                onSaved={handleEnvSaved}
              />
            </DetailTabContent>
          ) : null}

          <DetailTabContent active={tab} lazy value="logs">
            <DatabaseLogs
              databaseId={database.id}
              databaseName={database.name}
              generation={`${database.status}:${database.updatedAt}`}
            />
          </DetailTabContent>

          <DetailTabContent active={tab} lazy value="monitoring">
            <DatabaseResources databaseId={database.id} />
          </DetailTabContent>

          {canEditConfig ? (
            <DetailTabContent active={tab} lazy value="advanced">
              <DatabaseAdvanced
                canEdit={canEditConfig}
                database={database}
                onRebuilt={showDeploymentLog}
              />
            </DetailTabContent>
          ) : null}

          <DetailTabContent active={tab} lazy value="backups">
            <BackupTab
              canCreate={canCreateBackup}
              canRestore={canRestoreBackup}
              defaultDatabaseName={database.databaseName ?? database.name}
              resourceName={database.name}
              subject={{ databaseId: database.id, kind: "database" }}
            />
          </DetailTabContent>
        </Tabs>
      </ResourceDetailFrame>
      <DatabaseProvisionDrawer
        deployment={focusedLog}
        deploymentId={shownLogId}
        onEnd={() => deployments.refetch()}
        onOpenChange={(next) => {
          if (!next) {
            navigate({
              search: (prev) => ({ ...prev, deployment: undefined }),
            });
          }
        }}
      />

      {terminal}
    </AppShell>
  );
}
