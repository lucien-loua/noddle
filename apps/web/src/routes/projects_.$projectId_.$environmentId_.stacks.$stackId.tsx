import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createFileRoute,
  notFound,
  redirect,
  useRouter,
} from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { DeleteStackAction } from "@/components/delete-stack-action";
import { DeploymentHistory } from "@/components/deployment-history";
import { DetailBreadcrumb } from "@/components/detail-breadcrumb";
import { LogStream } from "@/components/log-stream";
import { TabRail } from "@/components/tab-rail";
import { TeardownError } from "@/components/teardown-error";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsTrigger } from "@/components/ui/tabs";
import { WebhookPanel } from "@/components/webhook-panel";
import { serviceLabel } from "@/lib/format";
import { type RoleName, roles } from "@/lib/permissions";
import { useCan } from "@/lib/use-permission";
import { getAuthState } from "@/server/auth";
import { getStackDashboard } from "@/server/dashboard";
import { getStackDeployments, triggerStackRollback } from "@/server/stacks";
import { generateStackWebhook, getStackWebhook } from "@/server/webhooks";

const STACK_TABS = ["logs", "history", "webhook"] as const;

type StackTab = (typeof STACK_TABS)[number];

interface DetailSearch {
  deployment?: string;
  /** Active panel. Omitted when `logs` so the default URL stays clean. */
  tab?: StackTab;
}

function isStackTab(value: unknown): value is StackTab {
  return (
    typeof value === "string" &&
    (STACK_TABS as readonly string[]).includes(value)
  );
}

export const Route = createFileRoute(
  "/projects_/$projectId_/$environmentId_/stacks/$stackId"
)({
  beforeLoad: async () => {
    const state = await getAuthState();
    if (!state.signedIn) {
      throw redirect({ to: "/login" });
    }
    return { email: state.email, role: state.role };
  },
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

// `data-ending-style`: Base UI keeps the OUTGOING panel mounted for the
// duration of its closing transition. With `flex-1`, that panel kept its
// height during that time — both contents showed up one under the other,
// and the new one ended up pushed down. Explicitly neutralizing it is what
// makes the tab switch clean.
const TAB_PANEL =
  "scroll-fade no-scrollbar -mx-2 min-h-0 flex-1 overflow-y-auto px-2 pt-4 data-ending-style:hidden";

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

  const deployments = useQuery({
    queryFn: () => getStackDeployments({ data: { stackId: stack.id } }),
    queryKey: ["stack-deployments", stack.id],
  });

  const rollback = useMutation({
    mutationFn: (sourceDeploymentId: string) =>
      triggerStackRollback({ data: { sourceDeploymentId, stackId: stack.id } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["stack-deployments", stack.id],
      });
      await router.invalidate();
    },
  });

  const handleEnd = useCallback(async () => {
    await queryClient.invalidateQueries({
      queryKey: ["stack-deployments", stack.id],
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

  const handleTabChange = useCallback(
    (value: string) => {
      navigate({
        replace: true,
        search: (prev) => ({
          ...prev,
          tab: value === "logs" ? undefined : (value as StackTab),
        }),
      });
    },
    [navigate]
  );

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

  // We LEAVE the page once the teardown has started, as for a service: the
  // stack is disappearing, staying on it would show a detail view emptying
  // itself out.
  const handleDeleted = useCallback(
    () =>
      navigate({
        params: {
          environmentId: stack.environmentId,
          projectId: stack.projectId,
        },
        search: {},
        to: "/projects/$projectId/$environmentId",
      }),
    [navigate, stack.environmentId, stack.projectId]
  );

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
      <div className="flex h-full min-h-0 flex-col">
        <p className="mb-3 truncate text-muted-foreground text-sm">
          stack · {stack.serverName}
          {stack.domain ? ` · ${stack.domain}` : ""}
        </p>
        <TeardownError message={stack.lastError} />
        {deleteError ? (
          <Alert className="mb-3" variant="destructive">
            <AlertDescription>{deleteError}</AlertDescription>
          </Alert>
        ) : null}

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

          <TabsContent className={TAB_PANEL} value="webhook">
            <WebhookPanel
              canManage={canManageWebhook}
              generateWebhook={handleGenerateWebhook}
              getWebhook={handleGetWebhook}
              queryKey={["webhook", "stack", stack.id]}
            />
          </TabsContent>
        </Tabs>
      </div>
    </AppShell>
  );
}
