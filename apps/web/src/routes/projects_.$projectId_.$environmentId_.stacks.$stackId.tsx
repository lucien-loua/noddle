import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, notFound, useRouter } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { DeleteStackAction } from "@/components/delete-stack-action";
import { DeploymentHistory } from "@/components/deployment-history";
import { DetailBreadcrumb } from "@/components/detail-breadcrumb";
import { WebhookPanel } from "@/components/features/webhooks/panel";
import { LogStream } from "@/components/log-stream";
import { ResourceDetailFrame } from "@/components/resource-detail/resource-detail-frame";
import { TabRail } from "@/components/tab-rail";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsTrigger } from "@/components/ui/tabs";
import { serviceLabel } from "@/lib/format";
import { type RoleName, roles } from "@/lib/permissions";
import { queries } from "@/lib/queries";
import { resourceDetailBeforeLoad } from "@/lib/resource-detail/auth-before-load";
import { STACK_DETAIL_TAB_PANEL_CLASS } from "@/lib/resource-detail/constants";
import { isDetailTab } from "@/lib/resource-detail/parse-tab";
import { useDetailTabChange } from "@/lib/resource-detail/use-detail-tab";
import { useLeaveOnDelete } from "@/lib/resource-detail/use-leave-on-delete";
import { useCan } from "@/lib/use-permission";
import { getStackDashboard } from "@/server/dashboard";
import { triggerStackRollback } from "@/server/stacks";
import { generateStackWebhook, getStackWebhook } from "@/server/webhooks";

const STACK_TABS = ["logs", "history", "webhook"] as const;

type StackTab = (typeof STACK_TABS)[number];

interface DetailSearch {
  deployment?: string;
  /** Active panel. Omitted when `logs` so the default URL stays clean. */
  tab?: StackTab;
}

function isStackTab(value: unknown): value is StackTab {
  return isDetailTab(value, STACK_TABS);
}

export const Route = createFileRoute(
  "/projects_/$projectId_/$environmentId_/stacks/$stackId"
)({
  beforeLoad: resourceDetailBeforeLoad,
  component: StackDetail,
  loader: async ({ context, params }) => {
    const stacks = await getStackDashboard();
    const stack = stacks.find((s) => s.id === params.stackId);
    if (!stack) {
      throw notFound();
    }
    return { email: context.email, role: context.role, stack };
  },
  validateSearch: (search: Record<string, unknown>): DetailSearch => ({
    deployment:
      typeof search.deployment === "string" ? search.deployment : undefined,
    tab: isStackTab(search.tab) ? search.tab : undefined,
  }),
});

function StackDetail() {
  const { email, role, stack } = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const router = useRouter();
  const queryClient = useQueryClient();

  const known: RoleName | null =
    role && role in roles ? (role as RoleName) : null;
  const canRollback = useCan(known, "service", "rollback");
  const canManageWebhook = useCan(known, "service", "create");

  const [deleteError, setDeleteError] = useState<string | null>(null);

  const deployments = useQuery(queries.stackDeployments(stack.id));

  const rollback = useMutation({
    mutationFn: (sourceDeploymentId: string) =>
      triggerStackRollback({ data: { sourceDeploymentId, stackId: stack.id } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: queries.stackDeployments(stack.id).queryKey,
      });
      await router.invalidate();
    },
  });

  const handleEnd = useCallback(async () => {
    await queryClient.invalidateQueries({
      queryKey: queries.stackDeployments(stack.id).queryKey,
    });
    await router.invalidate();
  }, [queryClient, router, stack.id]);

  const handleFocus = useCallback(
    (deploymentId: string) =>
      navigate({
        replace: true,
        search: (prev) => ({
          ...prev,
          deployment: deploymentId,
          tab: undefined,
        }),
      }),
    [navigate]
  );

  const handleTabChange = useDetailTabChange(navigate, "logs", {
    preserveSearch: true,
  });

  const handleRollback = useCallback(
    (deploymentId: string) => rollback.mutate(deploymentId),
    [rollback]
  );

  const handleGetWebhook = useCallback(
    () => getStackWebhook({ data: { stackId: stack.id } }),
    [stack.id]
  );
  const handleGenerateWebhook = useCallback(
    () => generateStackWebhook({ data: { stackId: stack.id } }),
    [stack.id]
  );

  const handleDeleted = useLeaveOnDelete({
    environmentId: stack.environmentId,
    navigate,
    projectId: stack.projectId,
    queryClient,
    resetSearch: true,
  });

  const currentDeploymentId = stack.lastDeployment
    ? stack.lastDeployment.id
    : null;
  const shown = search.deployment ?? currentDeploymentId;
  const status = serviceLabel(stack.status);

  return (
    <AppShell
      actions={
        <>
          {stack.watching ? (
            <Badge
              title="Post-deploy watch running: Noddle is still observing this stack and will roll it back if any of its services starts crash-looping."
              variant="outline"
            >
              watching
            </Badge>
          ) : null}
          <Badge variant="outline">{status.label}</Badge>
          <DeleteStackAction
            onDeleted={handleDeleted}
            onError={setDeleteError}
            role={known}
            stackId={stack.id}
            stackName={stack.name}
          />
        </>
      }
      breadcrumb={
        <DetailBreadcrumb
          environment={stack.environment}
          name={stack.name}
          // The parent is the ENVIRONMENT, not a global screen: it's where
          // you come from and where the resource is listed.
          parent={{
            environmentId: stack.environmentId,
            label: stack.environment,
            projectId: stack.projectId,
            to: "/projects/$projectId/$environmentId",
          }}
          project={stack.project}
        />
      }
      email={email}
      role={role}
      title={stack.name}
    >
      <ResourceDetailFrame
        deleteError={deleteError}
        subtitle={
          <>
            stack · {stack.serverName}
            {stack.domain ? ` · ${stack.domain}` : ""}
          </>
        }
        teardownError={stack.lastError}
      >
        <Tabs
          className="min-h-0 flex-1"
          onValueChange={handleTabChange}
          value={search.tab ?? "logs"}
        >
          <TabRail>
            <TabsTrigger value="logs">Logs</TabsTrigger>
            <TabsTrigger value="history">History</TabsTrigger>
            <TabsTrigger value="webhook">Webhook</TabsTrigger>
          </TabRail>

          <TabsContent className={STACK_DETAIL_TAB_PANEL_CLASS} value="logs">
            {shown ? (
              <LogStream deploymentId={shown} onEnd={handleEnd} />
            ) : (
              <p className="text-muted-foreground text-sm">
                No deploys yet — logs will appear on the first build.
              </p>
            )}
          </TabsContent>

          <TabsContent className={STACK_DETAIL_TAB_PANEL_CLASS} value="history">
            <p className="mb-2 truncate text-muted-foreground text-xs">
              {stack.gitRepoUrl}
              {stack.gitBranch ? ` · ${stack.gitBranch}` : ""}
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

          <TabsContent className={STACK_DETAIL_TAB_PANEL_CLASS} value="webhook">
            <WebhookPanel
              canManage={canManageWebhook}
              generateWebhook={handleGenerateWebhook}
              getWebhook={handleGetWebhook}
              queryKey={["webhook", "stack", stack.id]}
            />
          </TabsContent>
        </Tabs>
      </ResourceDetailFrame>
    </AppShell>
  );
}
