import { ArrowSquareOutIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { BuildLogsDialog } from "@/components/build-logs-dialog";
import { DeploymentHistory } from "@/components/deployment-history";
import { DetailBreadcrumb } from "@/components/detail-breadcrumb";
import { BackupTab } from "@/components/features/backup-shared/backup-tab";
import { ContainerLogs } from "@/components/features/database/database-logs";
import { EnvVarPanel } from "@/components/features/env-vars/panel";
import { ServiceBuild } from "@/components/features/services/service-build";
import { ServiceDangerZone } from "@/components/features/services/service-danger-zone";
import { ServiceDeploySettings } from "@/components/features/services/service-deploy-settings";
import { ServiceDomains } from "@/components/features/services/service-domains";
import { ServiceProvider } from "@/components/features/services/service-provider";
import { ServiceStatusLine } from "@/components/features/services/service-status-line";
import { WebhookPanel } from "@/components/features/webhooks/panel";
import { RelativeTime } from "@/components/relative-time";
import { ServiceRegistry } from "@/components/service-registry";
import { ServiceResources } from "@/components/service-resources";
import { TabRail } from "@/components/tab-rail";
import { TeardownError } from "@/components/teardown-error";
import { useTerminalDialog } from "@/components/terminal-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@/components/ui/frame";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsTrigger } from "@/components/ui/tabs";
import type { LifecycleAction } from "@/components/use-lifecycle-actions";
import { cache } from "@/lib/cache";
import { shortSha } from "@/lib/format";
import { type RoleName, roles } from "@/lib/permissions";
import { queries } from "@/lib/queries";
import { useCan } from "@/lib/use-permission";
import { getAuthState } from "@/server/auth";
import {
  type DeploymentSummary,
  getService,
  type ServiceRow,
} from "@/server/dashboard";
import { triggerDeploy, triggerRollback } from "@/server/deployments";
import { generateServiceWebhook, getServiceWebhook } from "@/server/webhooks";

/**
 * Application rail: General (source + build), Environment, Domains,
 * Deployments (build history + webhook), Volume backups, Logs (runtime), Monitoring,
 * Advanced. Empty tabs stay out.
 */
const SERVICE_TABS = [
  "general",
  "env",
  "domains",
  "deployments",
  "volume-backups",
  "logs",
  "monitoring",
  "advanced",
] as const;

type ServiceTab = (typeof SERVICE_TABS)[number];

const LEGACY_TABS: Record<string, ServiceTab> = {
  history: "deployments",
  resources: "monitoring",
  webhook: "deployments",
};

const DETAIL_POLL_MS = 2000;
const AWAITING_TIMEOUT_MS = 60_000;

interface AwaitingLifecycle {
  action: LifecycleAction;
  since: number;
  status: string;
  updatedAt: string;
}

function isLifecycleSettled(
  row: ServiceRow,
  awaiting: AwaitingLifecycle
): boolean {
  if (Date.now() - awaiting.since > AWAITING_TIMEOUT_MS) {
    return true;
  }
  if (awaiting.action === "restart") {
    return row.updatedAt !== awaiting.updatedAt;
  }
  return row.status !== awaiting.status;
}

function servicePollMs(
  row: ServiceRow | undefined,
  awaiting: AwaitingLifecycle | null
): number | false {
  if (!row) {
    return false;
  }
  if (row.status === "deleting" || row.status === "deploying") {
    return DETAIL_POLL_MS;
  }
  if (!awaiting) {
    return false;
  }
  return isLifecycleSettled(row, awaiting) ? false : DETAIL_POLL_MS;
}

interface DetailSearch {
  deployment?: string;
  /** Active panel. Omitted when `general` so the default URL stays clean. */
  tab?: ServiceTab;
}

function parseServiceTab(value: unknown): ServiceTab | undefined {
  if (typeof value !== "string") {
    return;
  }
  if ((SERVICE_TABS as readonly string[]).includes(value)) {
    return value as ServiceTab;
  }
  return LEGACY_TABS[value];
}

export const Route = createFileRoute(
  "/projects_/$projectId_/$environmentId_/services/$serviceId"
)({
  beforeLoad: async () => {
    const state = await getAuthState();
    if (!state.signedIn) {
      throw redirect({ to: "/login" });
    }
    return { email: state.email, role: state.role };
  },
  component: ServiceDetail,
  loader: async ({ context, params }) => {
    const service = await getService({ data: { serviceId: params.serviceId } });
    if (!service) {
      throw notFound();
    }
    return { email: context.email, role: context.role, service };
  },
  validateSearch: (search: Record<string, unknown>): DetailSearch => ({
    deployment:
      typeof search.deployment === "string" ? search.deployment : undefined,
    tab: parseServiceTab(search.tab),
  }),
});

const TAB_PANEL =
  "scroll-fade no-scrollbar -mx-2 min-h-0 flex-1 overflow-y-auto px-2 data-ending-style:hidden";

function Fact({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="min-w-0">
      <dt className="mb-0.5 text-muted-foreground text-xs">{label}</dt>
      <dd className="truncate text-sm">{children}</dd>
    </div>
  );
}

function ServiceFacts({
  role,
  runningOn,
  service,
}: {
  role: RoleName | null;
  runningOn: string | null;
  service: ServiceRow;
}) {
  return (
    <Frame variant="ghost">
      <FrameHeader>
        <FrameTitle>Details</FrameTitle>
        <FrameDescription>
          Where this application runs and which commit is currently served.
        </FrameDescription>
      </FrameHeader>
      <FramePanel>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
          <Fact label="Domains">
            {service.domains.length > 0 ? (
              <ul className="space-y-1">
                {service.domains.map((d) => {
                  const scheme = d.https ? "https" : "http";
                  return (
                    <li key={d.id}>
                      <a
                        className="flex items-center gap-1 underline underline-offset-4 hover:text-foreground"
                        href={`${scheme}://${d.host}`}
                        rel="noreferrer noopener"
                        target="_blank"
                      >
                        <span className="min-w-0 truncate">{d.host}</span>
                        <ArrowSquareOutIcon className="size-3.5 shrink-0" />
                      </a>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <span className="text-muted-foreground">Not reachable</span>
            )}
          </Fact>

          <Fact label="Commit">
            {service.lastDeployment?.commitSha ? (
              <span className="font-mono">
                {shortSha(service.lastDeployment.commitSha)}
              </span>
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
          </Fact>

          <Fact label="Last deploy">
            {service.lastDeployment ? (
              <RelativeTime iso={service.lastDeployment.createdAt} />
            ) : (
              <span className="text-muted-foreground">Never</span>
            )}
          </Fact>

          <Fact label={runningOn ? "Running on" : "Server"}>
            {runningOn && runningOn !== service.serverName
              ? `${runningOn} (built on ${service.serverName})`
              : service.serverName}
          </Fact>

          <Fact label="Registry">
            <ServiceRegistry
              registryId={service.registryId}
              role={role}
              serviceId={service.id}
            />
          </Fact>
        </dl>
      </FramePanel>
    </Frame>
  );
}

function ServiceDeploymentsPanel({
  canManageWebhook,
  canRollback,
  currentDeploymentId,
  deployments,
  onGenerateWebhook,
  onGetWebhook,
  onRollback,
  onSelect,
  pending,
  rollbackError,
  serviceId,
  shown,
}: {
  canManageWebhook: boolean;
  canRollback: boolean;
  currentDeploymentId: string | null;
  deployments: DeploymentSummary[] | undefined;
  onGenerateWebhook: () => Promise<{ path: string; secret: string }>;
  onGetWebhook: () => Promise<{ configured: boolean; path: string }>;
  onRollback: (deploymentId: string) => void;
  onSelect: (deploymentId: string) => void;
  pending: boolean;
  rollbackError: string | null;
  serviceId: string;
  shown: string | null;
}) {
  const recentDeployments = deployments?.slice(0, 10);

  return (
    <div className="flex flex-col gap-4">
      <Frame variant="ghost">
        <FrameHeader>
          <FrameTitle>Deployments</FrameTitle>
          <FrameDescription>
            See the last 10 deployments for this application.
          </FrameDescription>
        </FrameHeader>
        <FramePanel
          className={
            recentDeployments && recentDeployments.length > 0
              ? "p-0"
              : undefined
          }
        >
          {recentDeployments ? (
            <DeploymentHistory
              canRollback={canRollback}
              currentDeploymentId={currentDeploymentId}
              deployments={recentDeployments}
              onRollback={onRollback}
              onSelect={onSelect}
              pending={pending}
              selectedId={shown}
            />
          ) : (
            <Spinner />
          )}
          {rollbackError ? (
            <Alert className="m-3" variant="destructive">
              <AlertDescription>{rollbackError}</AlertDescription>
            </Alert>
          ) : null}
        </FramePanel>
      </Frame>

      <WebhookPanel
        canManage={canManageWebhook}
        generateWebhook={onGenerateWebhook}
        getWebhook={onGetWebhook}
        queryKey={["webhook", "service", serviceId]}
      />
    </div>
  );
}

function ServiceDetail() {
  const { email, role, service: initialService } = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);
  const [awaiting, setAwaiting] = useState<AwaitingLifecycle | null>(null);

  const known: RoleName | null =
    role && role in roles ? (role as RoleName) : null;
  const canRollback = useCan(known, "service", "rollback");
  const canDeploy = useCan(known, "service", "deploy");
  const canManageWebhook = useCan(known, "service", "create");
  const canCreateVolumeBackup = useCan(known, "backup", "create");
  const canRestoreVolumeBackup = useCan(known, "backup", "restore");
  const canReadEnvVar = useCan(known, "envVar", "read");
  const canShell = useCan(known, "container", "shell");
  const { openTerminal, terminal } = useTerminalDialog();

  const serviceQuery = useQuery({
    ...queries.service(initialService.id),
    initialData: initialService,
    refetchInterval: (q) => servicePollMs(q.state.data, awaiting),
  });
  const service = serviceQuery.data ?? initialService;

  useEffect(() => {
    if (!awaiting) {
      return;
    }
    if (isLifecycleSettled(service, awaiting)) {
      setAwaiting(null);
    }
  }, [awaiting, service]);

  const requestedTab = search.tab ?? "general";
  const tab =
    requestedTab === "env" && !canReadEnvVar ? "general" : requestedTab;

  const handleTabChange = useCallback(
    (value: string) => {
      navigate({
        replace: true,
        search: (prev) => ({
          ...prev,
          tab: value === "general" ? undefined : (value as ServiceTab),
        }),
      });
    },
    [navigate]
  );

  const deployments = useQuery({
    ...queries.deployments(service.id),
    refetchInterval: service.status === "deploying" ? DETAIL_POLL_MS : false,
  });

  const runningOn = service.lastDeployment?.nodeName ?? null;

  const handleLifecycleDone = useCallback(
    async (action: LifecycleAction) => {
      setAwaiting({
        action,
        since: Date.now(),
        status: service.status,
        updatedAt: service.updatedAt,
      });
      await cache.service(queryClient, service.id);
      await cache.environmentScope(
        queryClient,
        service.projectId,
        service.environmentId
      );
    },
    [
      queryClient,
      service.environmentId,
      service.id,
      service.projectId,
      service.status,
      service.updatedAt,
    ]
  );

  const handleDeleted = useCallback(async () => {
    await cache.environmentScope(
      queryClient,
      service.projectId,
      service.environmentId
    );
    await navigate({
      params: {
        environmentId: service.environmentId,
        projectId: service.projectId,
      },
      search: {},
      to: "/projects/$projectId/$environmentId",
    });
  }, [navigate, queryClient, service.environmentId, service.projectId]);

  const deploy = useMutation({
    mutationFn: () => triggerDeploy({ data: { serviceId: service.id } }),
    onError: (e: Error) => setActionError(e.message),
    onSuccess: async (result) => {
      setActionError(null);
      await cache.service(queryClient, service.id);
      await queryClient.invalidateQueries({
        queryKey: queries.deployments(service.id).queryKey,
      });
      await cache.environmentScope(
        queryClient,
        service.projectId,
        service.environmentId
      );
      await navigate({
        replace: true,
        search: (prev) => ({
          ...prev,
          deployment: result.deploymentId,
          tab: "deployments",
        }),
      });
    },
  });
  const handleDeploy = useCallback(() => deploy.mutate(), [deploy]);

  const rollback = useMutation({
    mutationFn: (deploymentId: string) =>
      triggerRollback({ data: { deploymentId, serviceId: service.id } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: queries.deployments(service.id).queryKey,
      });
      await cache.service(queryClient, service.id);
    },
  });

  const handleEnd = useCallback(async () => {
    await queryClient.invalidateQueries({
      queryKey: queries.deployments(service.id).queryKey,
    });
    await cache.service(queryClient, service.id);
  }, [queryClient, service.id]);

  const handleFocus = useCallback(
    (deploymentId: string) => {
      navigate({
        replace: true,
        search: (prev) => ({
          ...prev,
          deployment: deploymentId,
          tab: "deployments",
        }),
      });
    },
    [navigate]
  );

  const handleLogsOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        return;
      }
      navigate({
        replace: true,
        search: (prev) => ({ ...prev, deployment: undefined }),
      });
    },
    [navigate]
  );

  const handleRollback = useCallback(
    (deploymentId: string) => rollback.mutate(deploymentId),
    [rollback]
  );

  const handleGetWebhook = useCallback(
    () => getServiceWebhook({ data: { serviceId: service.id } }),
    [service.id]
  );
  const handleGenerateWebhook = useCallback(
    () => generateServiceWebhook({ data: { serviceId: service.id } }),
    [service.id]
  );

  const currentDeploymentId = service.lastDeployment
    ? service.lastDeployment.id
    : null;
  const shown = search.deployment ?? null;
  const focused = deployments.data?.find((row) => row.id === shown) ?? null;

  const handleOpenTerminal = useCallback(() => {
    openTerminal({
      id: service.id,
      kind: "container",
      target: "service",
      title: service.name,
    });
  }, [openTerminal, service.id, service.name]);

  return (
    <AppShell
      breadcrumb={
        <DetailBreadcrumb
          environment={service.environment}
          name={service.name}
          parent={{
            environmentId: service.environmentId,
            label: service.environment,
            projectId: service.projectId,
            to: "/projects/$projectId/$environmentId",
          }}
          project={service.project}
        />
      }
      email={email}
      role={role}
      title={service.name}
    >
      <div className="flex h-full min-h-0 flex-col">
        <ServiceStatusLine
          pendingAction={awaiting?.action ?? null}
          service={service}
        />
        <TeardownError message={service.lastError} />
        {actionError ? (
          <Alert className="mb-3" variant="destructive">
            <AlertDescription>{actionError}</AlertDescription>
          </Alert>
        ) : null}

        <Tabs
          className="min-h-0 flex-1 gap-3"
          onValueChange={handleTabChange}
          value={tab}
        >
          <div className="flex shrink-0 flex-col gap-3">
            <TabRail>
              <TabsTrigger value="general">General</TabsTrigger>
              {canReadEnvVar ? (
                <TabsTrigger value="env">Environment</TabsTrigger>
              ) : null}
              <TabsTrigger value="domains">Domains</TabsTrigger>
              <TabsTrigger value="deployments">Deployments</TabsTrigger>
              <TabsTrigger value="volume-backups">Volume backups</TabsTrigger>
              <TabsTrigger value="logs">Logs</TabsTrigger>
              <TabsTrigger value="monitoring">Monitoring</TabsTrigger>
              <TabsTrigger value="advanced">Advanced</TabsTrigger>
            </TabRail>

            <ServiceDeploySettings
              deployPending={deploy.isPending}
              known={known}
              onDeploy={handleDeploy}
              onDone={handleLifecycleDone}
              onError={setActionError}
              onTerminal={canShell ? handleOpenTerminal : null}
              pendingAction={awaiting?.action ?? null}
              service={service}
            />
          </div>

          <TabsContent className={TAB_PANEL} value="general">
            <div className="flex flex-col gap-4">
              <ServiceProvider canEdit={canDeploy} service={service} />
              <ServiceBuild canEdit={canDeploy} service={service} />
              {service.status === "created" ? (
                <p className="text-muted-foreground text-sm">
                  Nothing is running yet. Save the repository, then Deploy.
                </p>
              ) : null}
            </div>
          </TabsContent>

          {canReadEnvVar ? (
            <TabsContent className={TAB_PANEL} value="env">
              <EnvVarPanel
                effect="Takes effect on the next deploy."
                serviceId={service.id}
              />
            </TabsContent>
          ) : null}

          <TabsContent className={TAB_PANEL} value="domains">
            <ServiceDomains canEdit={canDeploy} service={service} />
          </TabsContent>

          <TabsContent className={TAB_PANEL} value="deployments">
            <ServiceDeploymentsPanel
              canManageWebhook={canManageWebhook}
              canRollback={canRollback}
              currentDeploymentId={currentDeploymentId}
              deployments={deployments.data}
              onGenerateWebhook={handleGenerateWebhook}
              onGetWebhook={handleGetWebhook}
              onRollback={handleRollback}
              onSelect={handleFocus}
              pending={rollback.isPending}
              rollbackError={rollback.error?.message ?? null}
              serviceId={service.id}
              shown={shown}
            />
          </TabsContent>

          <TabsContent className={TAB_PANEL} value="volume-backups">
            <BackupTab
              canCreate={canCreateVolumeBackup}
              canRestore={canRestoreVolumeBackup}
              resourceName={service.name}
              subject={{ kind: "volume", serviceId: service.id }}
            />
          </TabsContent>

          <TabsContent className={TAB_PANEL} value="logs">
            <ContainerLogs
              generation={`${service.status}:${service.updatedAt}`}
              name={service.name}
              streamUrl={`/api/service-logs/${service.id}`}
            />
          </TabsContent>

          <TabsContent className={TAB_PANEL} value="monitoring">
            <ServiceResources serviceId={service.id} />
          </TabsContent>

          <TabsContent className={TAB_PANEL} value="advanced">
            <div className="flex flex-col gap-4">
              <ServiceFacts
                role={known}
                runningOn={runningOn}
                service={service}
              />
              <ServiceDangerZone
                onDeleted={handleDeleted}
                onError={setActionError}
                role={known}
                serviceId={service.id}
                serviceName={service.name}
              />
            </div>
          </TabsContent>
        </Tabs>
      </div>
      {terminal}
      <BuildLogsDialog
        deployment={focused}
        deploymentId={shown}
        onEnd={handleEnd}
        onOpenChange={handleLogsOpenChange}
        open={shown !== null}
      />
    </AppShell>
  );
}
