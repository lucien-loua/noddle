// Le détail d'un service, sur SA page.
//
// Il vivait déplié sous sa ligne dans le dashboard : cliquer poussait tout
// ce qui suivait vers le bas, donc les autres services sortaient de l'écran
// — c'est-à-dire que la seule chose que ce dashboard doit faire, les
// montrer tous, cassait au premier clic. Ici, ouvrir un détail ne déplace
// rien : on change de page, et l'URL dit laquelle.
//
// Le déploiement affiché reste dans la recherche (`?deployment=`), comme
// avant : un lien partagé rouvre le même build, pas seulement le service.

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
import { type DraftVar, EnvVarTable } from "@/components/env-var-table";
import { LogStream } from "@/components/log-stream";
import { ServiceResources } from "@/components/service-resources";
import { TabRail } from "@/components/tab-rail";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsTrigger } from "@/components/ui/tabs";
import { WebhookPanel } from "@/components/webhook-panel";
import { serviceLabel } from "@/lib/format";
import { type RoleName, roles } from "@/lib/permissions";
import { useCan } from "@/lib/use-permission";
import { getAuthState } from "@/server/auth";
import { getDashboard, getDeployments } from "@/server/dashboard";
import { triggerRollback } from "@/server/deployments";
import { getEnvVars, saveEnvVars } from "@/server/env-vars";
import { generateServiceWebhook, getServiceWebhook } from "@/server/webhooks";

interface DetailSearch {
  deployment?: string;
}

export const Route = createFileRoute("/services/$serviceId")({
  beforeLoad: async () => {
    const state = await getAuthState();
    if (!state.signedIn) {
      throw redirect({ to: "/login" });
    }
    return { email: state.email, role: state.role };
  },
  component: ServiceDetail,
  // Le tableau de bord entier plutôt qu'une server function dédiée : c'est
  // la même lecture, déjà gardée, déjà éprouvée. En ajouter une seconde
  // pour un seul service élargirait la surface de permissions sans rien
  // apporter à cette échelle.
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

// Chaque panneau défile pour lui-même : le rail d'onglets reste atteignable
// quel que soit le contenu, et un historique long n'allonge pas la page.
//
// `data-ending-style` : Base UI garde le panneau SORTANT monté le temps de
// sa transition de fermeture. Avec `flex-1`, ce panneau-là gardait sa
// hauteur pendant ce temps — les deux contenus s'affichaient l'un sous
// l'autre, et le nouveau se retrouvait poussé vers le bas. Le neutraliser
// explicitement est ce qui rend la bascule d'onglet propre.
const TAB_PANEL =
  "scroll-fade no-scrollbar -mx-2 min-h-0 flex-1 overflow-y-auto px-2 pt-4 data-ending-style:hidden";

function ServiceDetail() {
  const { email, role, service } = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [saveError, setSaveError] = useState<string | null>(null);

  const known: RoleName | null =
    role && role in roles ? (role as RoleName) : null;
  const canRollback = useCan(known, "service", "rollback");
  const canManageWebhook = useCan(known, "service", "create");
  // `envVar` n'est PAS dans le rôle opérateur : « quelqu'un qui doit pouvoir
  // livrer n'a pas à voir les secrets » (permissions.ts). `enabled` évite un
  // appel qui échouerait de toute façon depuis un onglet jamais affiché.
  const canReadEnvVar = useCan(known, "envVar", "read");

  const deployments = useQuery({
    queryFn: () => getDeployments({ data: { serviceId: service.id } }),
    queryKey: ["deployments", service.id],
  });

  // `null` sur un déploiement que Swarm a annulé — `nodeId` n'est écrit que
  // sur une bascule acceptée. L'écran retombe alors sur le seul serveur qu'il
  // sait vrai, celui du build, plutôt que d'affirmer un lieu d'exécution.
  const runningOn = service.lastDeployment?.nodeName ?? null;

  const envVars = useQuery({
    enabled: canReadEnvVar,
    queryFn: () => getEnvVars({ data: { serviceId: service.id } }),
    queryKey: ["env-vars", service.id],
  });

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

  const save = useMutation({
    mutationFn: (vars: DraftVar[]) =>
      saveEnvVars({
        data: {
          serviceId: service.id,
          vars: vars.map((v) => ({
            isSecret: v.isSecret,
            key: v.key,
            value: v.value,
          })),
        },
      }),
    onError: (error: Error) => setSaveError(error.message),
    onSuccess: async () => {
      setSaveError(null);
      await queryClient.invalidateQueries({
        queryKey: ["env-vars", service.id],
      });
    },
  });

  // Le flux se ferme, la vue se rafraîchit : le statut du service et son
  // dernier déploiement viennent du chargeur de route, pas du flux.
  const handleEnd = useCallback(async () => {
    await queryClient.invalidateQueries({
      queryKey: ["deployments", service.id],
    });
    await router.invalidate();
  }, [queryClient, router, service.id]);

  const handleFocus = useCallback(
    (deploymentId: string) =>
      navigate({ search: { deployment: deploymentId } }),
    [navigate]
  );

  const handleRollback = useCallback(
    (deploymentId: string) => rollback.mutate(deploymentId),
    [rollback]
  );

  const handleSave = useCallback(
    (vars: DraftVar[]) => save.mutate(vars),
    [save]
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
  const status = serviceLabel(service.status);

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
          <Badge variant="outline">{status.label}</Badge>
        </>
      }
      breadcrumb={
        <DetailBreadcrumb
          environment={service.environment}
          name={service.name}
          project={service.project}
        />
      }
      email={email}
      title={service.name}
    >
      <div className="flex h-full min-h-0 flex-col">
        {/* Deux serveurs, pas un — et seulement quand ils diffèrent.
            `serverName` est là où le service se CONSTRUIT ; avec un registre,
            l'image est portable et c'est Swarm qui décide où elle TOURNE. Les
            confondre ferait affirmer à l'écran une machine qui n'exécute rien.
            Sur une installation mono-machine, les deux coïncident et la
            distinction n'a pas à encombrer. */}
        <p className="mb-3 truncate text-muted-foreground text-sm">
          {runningOn && runningOn !== service.serverName
            ? `built on ${service.serverName} · running on ${runningOn}`
            : service.serverName}
          {service.domain ? ` · ${service.domain}` : ""}
        </p>

        <Tabs className="min-h-0 flex-1" defaultValue="logs">
          {/* Le rail défile dans SON conteneur : à 320 px, « Webhook » sortait
              de l'écran et devenait inatteignable — mesuré. */}
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
              {envVars.data ? (
                <EnvVarTable
                  // Remonte le tableau quand le serveur a confirmé : le
                  // brouillon repart de l'état réellement enregistré, jamais
                  // de ce qu'on croyait avoir envoyé.
                  key={envVars.data.map((v) => `${v.id}:${v.key}`).join(",")}
                  onSave={handleSave}
                  pending={save.isPending}
                  saved={envVars.data}
                />
              ) : (
                <Spinner />
              )}
              {saveError ? (
                <Alert className="mt-3" variant="destructive">
                  <AlertDescription>{saveError}</AlertDescription>
                </Alert>
              ) : null}
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
