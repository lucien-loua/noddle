import {
  ArrowClockwiseIcon,
  ArrowSquareOutIcon,
  CaretDownIcon,
  PlayIcon,
  StopIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createFileRoute,
  notFound,
  redirect,
  useRouter,
} from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { DeploymentHistory } from "@/components/deployment-history";
import { DetailBreadcrumb } from "@/components/detail-breadcrumb";
import { EnvVarPanel } from "@/components/env-var-panel";
import { LogStream } from "@/components/log-stream";
import { RelativeTime } from "@/components/relative-time";
import { ServiceRegistry } from "@/components/service-registry";
import { ServiceResources } from "@/components/service-resources";
import { TabRail } from "@/components/tab-rail";
import { TeardownError } from "@/components/teardown-error";
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
import {
  Frame,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@/components/ui/frame";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsTrigger } from "@/components/ui/tabs";
import { useDeleteServiceAction } from "@/components/use-delete-service-action";
import { useLifecycleActions } from "@/components/use-lifecycle-actions";
import { WebhookPanel } from "@/components/webhook-panel";
import { serviceLabel, shortSha } from "@/lib/format";
import { type RoleName, roles } from "@/lib/permissions";
import { useCan } from "@/lib/use-permission";
import { getAuthState } from "@/server/auth";
import {
  getDashboard,
  getDeployments,
  type ServiceRow,
} from "@/server/dashboard";
import { triggerRollback } from "@/server/deployments";
import { generateServiceWebhook, getServiceWebhook } from "@/server/webhooks";

interface DetailSearch {
  deployment?: string;
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
    const services = await getDashboard();
    const service = services.find((s) => s.id === params.serviceId);
    if (!service) {
      throw notFound();
    }
    return { email: context.email, role: context.role, service };
  },
  validateSearch: (search: Record<string, unknown>): DetailSearch => ({
    deployment:
      typeof search.deployment === "string" ? search.deployment : undefined,
  }),
});

const TAB_PANEL =
  "scroll-fade no-scrollbar -mx-2 min-h-0 flex-1 overflow-y-auto px-2 pt-4 data-ending-style:hidden";

function Fact({
  children,
  label,
}: {
  children: React.ReactNode;
  label: string;
}) {
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
    <Frame className="mb-4" variant="ghost">
      <FrameHeader>
        <FrameTitle>Deployment details</FrameTitle>
      </FrameHeader>
      <FramePanel>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
          <Fact label="Domain">
            {service.domain ? (
              <a
                className="flex items-center gap-1 underline underline-offset-4 hover:text-foreground"
                href={`https://${service.domain}`}
                rel="noreferrer noopener"
                target="_blank"
              >
                <span className="min-w-0 truncate">{service.domain}</span>
                <ArrowSquareOutIcon className="size-3.5 shrink-0" />
              </a>
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

function ServiceHeaderActions({
  known,
  onDeleted,
  onDone,
  onError,
  service,
}: {
  known: RoleName | null;
  onDeleted: () => void;
  onDone: () => void;
  onError: (message: string) => void;
  service: ServiceRow;
}) {
  const lifecycle = useLifecycleActions({
    onDone,
    onError,
    role: known,
    serviceId: service.id,
    status: service.status,
  });
  const del = useDeleteServiceAction({
    onDeleted,
    onError,
    role: known,
    serviceId: service.id,
    serviceName: service.name,
  });

  if (!(lifecycle.available || del.canDelete)) {
    return null;
  }

  const status = serviceLabel(service.status);

  if (!lifecycle.available) {
    return (
      <>
        <ButtonGroup>
          <ButtonGroupText>{status.label}</ButtonGroupText>
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
        <ButtonGroupText>{status.label}</ButtonGroupText>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                aria-label={`Actions for ${service.name}`}
                size="icon"
                variant="outline"
              >
                <CaretDownIcon weight="bold" />
              </Button>
            }
          />
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              disabled={lifecycle.busy}
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
                disabled={lifecycle.busy}
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

function ServiceDetail() {
  const { email, role, service } = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);
  const [tab, setTab] = useState("logs");

  const known: RoleName | null =
    role && role in roles ? (role as RoleName) : null;
  const canRollback = useCan(known, "service", "rollback");
  const canManageWebhook = useCan(known, "service", "create");
  const canReadEnvVar = useCan(known, "envVar", "read");

  const deployments = useQuery({
    queryFn: () => getDeployments({ data: { serviceId: service.id } }),
    queryKey: ["deployments", service.id],
  });

  const runningOn = service.lastDeployment?.nodeName ?? null;

  const handleLifecycleDone = useCallback(() => {
    router.invalidate();
  }, [router]);

  const handleDeleted = useCallback(
    () =>
      navigate({
        params: {
          environmentId: service.environmentId,
          projectId: service.projectId,
        },
        search: {},
        to: "/projects/$projectId/$environmentId",
      }),
    [navigate, service.environmentId, service.projectId]
  );

  const rollback = useMutation({
    mutationFn: (deploymentId: string) =>
      triggerRollback({ data: { deploymentId, serviceId: service.id } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["deployments", service.id],
      });
      await router.invalidate();
    },
  });

  const handleEnd = useCallback(async () => {
    await queryClient.invalidateQueries({
      queryKey: ["deployments", service.id],
    });
    await router.invalidate();
  }, [queryClient, router, service.id]);

  const handleFocus = useCallback(
    (deploymentId: string) => {
      setTab("logs");
      navigate({ search: { deployment: deploymentId } });
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
  const shown = search.deployment ?? currentDeploymentId;

  return (
    <AppShell
      actions={
        <>
          {service.watching ? (
            <Badge
              title="Post-deploy watch running: Noddle is still observing this service and will roll it back if it starts crash-looping."
              variant="outline"
            >
              watching
            </Badge>
          ) : null}
          <ServiceHeaderActions
            known={known}
            onDeleted={handleDeleted}
            onDone={handleLifecycleDone}
            onError={setActionError}
            service={service}
          />
        </>
      }
      breadcrumb={
        <DetailBreadcrumb
          environment={service.environment}
          name={service.name}
          // The parent is the ENVIRONMENT, not a global screen: it's where
          // you come from and where the resource is listed.
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
        <ServiceFacts role={known} runningOn={runningOn} service={service} />
        <TeardownError message={service.lastError} />
        {/* Errors from header actions (start, stop, delete). They used to
            show up in the Variables tab — an unrelated place that made
            them invisible from any other tab. Here, next to `lastError`,
            which is the same idea. */}
        {actionError ? (
          <Alert className="mb-3" variant="destructive">
            <AlertDescription>{actionError}</AlertDescription>
          </Alert>
        ) : null}

        <Tabs className="min-h-0 flex-1" onValueChange={setTab} value={tab}>
          {/* The rail scrolls within ITS OWN container: at 320px, "Webhook"
              would go off-screen and become unreachable — measured. */}
          <TabRail>
            <TabsTrigger value="logs">Logs</TabsTrigger>
            <TabsTrigger value="history">History</TabsTrigger>
            {canReadEnvVar ? (
              <TabsTrigger value="env">Variables</TabsTrigger>
            ) : null}
            <TabsTrigger value="resources">Resources</TabsTrigger>
            <TabsTrigger value="webhook">Webhook</TabsTrigger>
          </TabRail>

          <TabsContent className={TAB_PANEL} value="logs">
            {shown ? (
              <LogStream deploymentId={shown} onEnd={handleEnd} />
            ) : (
              <p className="text-muted-foreground text-sm">
                No deploys yet — logs will appear on the first build.
              </p>
            )}
          </TabsContent>

          <TabsContent className={TAB_PANEL} value="history">
            <p className="mb-2 truncate text-muted-foreground text-xs">
              {service.gitRepoUrl ?? "—"}
              {service.gitBranch ? ` · ${service.gitBranch}` : ""}
            </p>
            {deployments.data ? (
              <DeploymentHistory
                canRollback={canRollback}
                currentDeploymentId={currentDeploymentId}
                deployments={deployments.data}
                onRollback={handleRollback}
                onSelect={handleFocus}
                pending={rollback.isPending}
                selectedId={shown}
              />
            ) : (
              <Spinner />
            )}
            {rollback.error ? (
              <Alert className="mt-3" variant="destructive">
                <AlertDescription>{rollback.error.message}</AlertDescription>
              </Alert>
            ) : null}
          </TabsContent>

          {canReadEnvVar ? (
            <TabsContent className={TAB_PANEL} value="env">
              <EnvVarPanel
                effect="Takes effect on the next deploy."
                serviceId={service.id}
              />
            </TabsContent>
          ) : null}

          <TabsContent className={TAB_PANEL} value="resources">
            <ServiceResources serviceId={service.id} />
          </TabsContent>

          <TabsContent className={TAB_PANEL} value="webhook">
            <WebhookPanel
              canManage={canManageWebhook}
              generateWebhook={handleGenerateWebhook}
              getWebhook={handleGetWebhook}
              queryKey={["webhook", "service", service.id]}
            />
          </TabsContent>
        </Tabs>
      </div>
    </AppShell>
  );
}
