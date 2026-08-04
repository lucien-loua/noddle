// Le détail d'une pile Compose, sur SA page. Même raison que pour un
// service : le dépliage inline déplaçait tout ce qui suivait.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createFileRoute,
  notFound,
  redirect,
  useRouter,
} from "@tanstack/react-router";
import { useCallback } from "react";
import { AppShell } from "@/components/app-shell";
import { DeploymentHistory } from "@/components/deployment-history";
import { DetailBreadcrumb } from "@/components/detail-breadcrumb";
import { LogStream } from "@/components/log-stream";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { WebhookPanel } from "@/components/webhook-panel";
import { serviceLabel } from "@/lib/format";
import { type RoleName, roles } from "@/lib/permissions";
import { useCan } from "@/lib/use-permission";
import { getAuthState } from "@/server/auth";
import { getStackDashboard } from "@/server/dashboard";
import { getStackDeployments, triggerStackRollback } from "@/server/stacks";
import { generateStackWebhook, getStackWebhook } from "@/server/webhooks";

interface DetailSearch {
  deployment?: string;
}

export const Route = createFileRoute("/stacks/$stackId")({
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
  }),
});

// `data-ending-style` : Base UI garde le panneau SORTANT monté le temps de
// sa transition de fermeture. Avec `flex-1`, ce panneau-là gardait sa
// hauteur pendant ce temps — les deux contenus s'affichaient l'un sous
// l'autre, et le nouveau se retrouvait poussé vers le bas. Le neutraliser
// explicitement est ce qui rend la bascule d'onglet propre.
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
      navigate({ search: { deployment: deploymentId } }),
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
        </>
      }
      breadcrumb={
        <DetailBreadcrumb
          environment={stack.environment}
          name={stack.name}
          project={stack.project}
        />
      }
      email={email}
      title={stack.name}
    >
      <div className="flex h-full min-h-0 flex-col">
        <p className="mb-3 truncate text-muted-foreground text-sm">
          stack · {stack.serverName}
          {stack.domain ? ` · ${stack.domain}` : ""}
        </p>

        <Tabs className="min-h-0 flex-1" defaultValue="logs">
          <TabsList className="scroll-fade-x no-scrollbar max-w-full shrink-0 overflow-x-auto">
            <TabsTrigger value="logs">Logs</TabsTrigger>
            <TabsTrigger value="history">History</TabsTrigger>
            <TabsTrigger value="webhook">Webhook</TabsTrigger>
          </TabsList>

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
              {stack.gitRepoUrl} · {stack.gitBranch}
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
