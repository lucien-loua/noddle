import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { lazy, useCallback, useEffect, useState } from "react";

import { AppShell } from "@/components/app-shell";
import { BuildLogsDialog } from "@/components/build-logs-dialog";
import { DetailBreadcrumb } from "@/components/detail-breadcrumb";
import { EnvVarPanel } from "@/components/features/env-vars/panel";
import { ServiceDangerZone } from "@/components/features/services/service-danger-zone";
import { ServiceDeploySettings } from "@/components/features/services/service-deploy-settings";
import { ServiceDomains } from "@/components/features/services/service-domains";
import { ServiceFacts } from "@/components/features/services/service-facts";
import { ServiceOverview } from "@/components/features/services/service-overview";
import { ServiceStatusLine } from "@/components/features/services/service-status-line";
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
import { DETAIL_POLL_MS, DETAIL_TAB_PANEL_CLASS } from "@/lib/resource-detail/constants";
import { isLifecycleSettled, lifecyclePollInterval } from "@/lib/resource-detail/lifecycle-poll";
import type { AwaitingLifecycle } from "@/lib/resource-detail/lifecycle-poll";
import { parseDetailTab } from "@/lib/resource-detail/parse-tab";
import { useDetailTabChange } from "@/lib/resource-detail/use-detail-tab";
import { useLeaveOnDelete } from "@/lib/resource-detail/use-leave-on-delete";
import { useCan } from "@/lib/use-permission";
import { getService } from "@/server/dashboard";
import { triggerDeploy, triggerRollback } from "@/server/deployments";
import { generateServiceWebhook, getServiceWebhook } from "@/server/webhooks";

const BackupTab = lazy(() =>
  import("@/components/features/backups/backup-tab").then((m) => ({
    default: m.BackupTab,
  })),
);
const ContainerLogs = lazy(() =>
  import("@/components/features/logs/container-logs").then((m) => ({
    default: m.ContainerLogs,
  })),
);
const ServiceDeploymentsPanel = lazy(() =>
  import("@/components/features/services/service-deployments-panel").then((m) => ({
    default: m.ServiceDeploymentsPanel,
  })),
);
const ServiceResources = lazy(() =>
  import("@/components/features/services/service-resources").then((m) => ({
    default: m.ServiceResources,
  })),
);

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

interface DetailSearch {
  deployment?: string;
  /** Active panel. Omitted when `general` so the default URL stays clean. */
  tab?: ServiceTab;
}

function parseServiceTab(value: unknown): ServiceTab | undefined {
  return parseDetailTab(value, SERVICE_TABS, LEGACY_TABS);
}

export const Route = createFileRoute("/projects_/$projectId_/$environmentId_/services/$serviceId")({
  beforeLoad: resourceDetailBeforeLoad,
  component: ServiceDetail,
  loader: async ({ context, params }) => {
    const service = await getService({ data: { serviceId: params.serviceId } });
    if (!service) {
      throw notFound();
    }
    return { email: context.email, role: context.role, service };
  },
  validateSearch: (search: Record<string, unknown>): DetailSearch => ({
    deployment: typeof search.deployment === "string" ? search.deployment : undefined,
    tab: parseServiceTab(search.tab),
  }),
});

function ServiceDetail() {
  const { email, role, service: initialService } = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);
  const [awaiting, setAwaiting] = useState<AwaitingLifecycle | null>(null);

  const known: RoleName | null = role && role in roles ? (role as RoleName) : null;
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
    refetchInterval: (q) =>
      lifecyclePollInterval(q.state.data, awaiting, {
        forcePoll: q.state.data?.status === "deleting" || q.state.data?.status === "deploying",
      }),
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
  const tab = requestedTab === "env" && !canReadEnvVar ? "general" : requestedTab;

  const handleTabChange = useDetailTabChange<ServiceTab>(navigate, "general", {
    preserveSearch: true,
  });

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
      await cache.environmentScope(queryClient, service.projectId, service.environmentId);
    },
    [
      queryClient,
      service.environmentId,
      service.id,
      service.projectId,
      service.status,
      service.updatedAt,
    ],
  );

  const handleDeleted = useLeaveOnDelete({
    environmentId: service.environmentId,
    navigate,
    projectId: service.projectId,
    queryClient,
    resetSearch: true,
  });

  const deploy = useMutation({
    mutationFn: () => triggerDeploy({ data: { serviceId: service.id } }),
    onError: (e: Error) => setActionError(e.message),
    onSuccess: async (result) => {
      setActionError(null);
      await cache.service(queryClient, service.id);
      await queryClient.invalidateQueries({
        queryKey: queries.deployments(service.id).queryKey,
      });
      await cache.environmentScope(queryClient, service.projectId, service.environmentId);
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
    [navigate],
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
    [navigate],
  );

  const handleRollback = useCallback(
    (deploymentId: string) => rollback.mutate(deploymentId),
    [rollback],
  );

  const handleGetWebhook = useCallback(
    () => getServiceWebhook({ data: { serviceId: service.id } }),
    [service.id],
  );
  const handleGenerateWebhook = useCallback(
    () => generateServiceWebhook({ data: { serviceId: service.id } }),
    [service.id],
  );

  const currentDeploymentId = service.lastDeployment ? service.lastDeployment.id : null;
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
      <ResourceDetailFrame
        deleteError={actionError}
        subtitle={<ServiceStatusLine pendingAction={awaiting?.action ?? null} service={service} />}
        teardownError={service.lastError}
      >
        <Tabs className="min-h-0 flex-1 gap-3" onValueChange={handleTabChange} value={tab}>
          <div className="flex shrink-0 flex-col gap-3">
            <TabRail>
              <TabsTrigger value="general">General</TabsTrigger>
              {canReadEnvVar ? <TabsTrigger value="env">Environment</TabsTrigger> : null}
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

          <TabsContent className={DETAIL_TAB_PANEL_CLASS} value="general">
            <ServiceOverview canEdit={canDeploy} service={service} />
          </TabsContent>

          {canReadEnvVar ? (
            <TabsContent className={DETAIL_TAB_PANEL_CLASS} value="env">
              <EnvVarPanel effect="Takes effect on the next deploy." serviceId={service.id} />
            </TabsContent>
          ) : null}

          <TabsContent className={DETAIL_TAB_PANEL_CLASS} value="domains">
            <ServiceDomains canEdit={canDeploy} service={service} />
          </TabsContent>

          <TabsContent className={DETAIL_TAB_PANEL_CLASS} value="deployments">
            <ActiveTabPanel active={tab} value="deployments">
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
            </ActiveTabPanel>
          </TabsContent>

          <TabsContent className={DETAIL_TAB_PANEL_CLASS} value="volume-backups">
            <ActiveTabPanel active={tab} value="volume-backups">
              <BackupTab
                canCreate={canCreateVolumeBackup}
                canRestore={canRestoreVolumeBackup}
                resourceName={service.name}
                subject={{ kind: "volume", serviceId: service.id }}
              />
            </ActiveTabPanel>
          </TabsContent>

          <TabsContent className={DETAIL_TAB_PANEL_CLASS} value="logs">
            <ActiveTabPanel active={tab} value="logs">
              <ContainerLogs
                generation={`${service.status}:${service.updatedAt}`}
                name={service.name}
                streamUrl={`/api/service-logs/${service.id}`}
              />
            </ActiveTabPanel>
          </TabsContent>

          <TabsContent className={DETAIL_TAB_PANEL_CLASS} value="monitoring">
            <ActiveTabPanel active={tab} value="monitoring">
              <ServiceResources serviceId={service.id} />
            </ActiveTabPanel>
          </TabsContent>

          <TabsContent className={DETAIL_TAB_PANEL_CLASS} value="advanced">
            <div className="flex flex-col gap-4">
              <ServiceFacts role={known} runningOn={runningOn} service={service} />
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
      </ResourceDetailFrame>
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
