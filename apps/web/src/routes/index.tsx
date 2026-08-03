// LE dashboard. Il n'y en a qu'un.
//
// Tous les services d'un coup d'œil, avec leur statut et leur dernier
// déploiement. Sélectionner un service ouvre son détail SOUS la ligne, sans
// quitter l'écran : c'est ce que veut dire « pas de page vue d'ensemble
// séparée ». La sélection vit dans l'URL, donc un état précis se partage.
//
// Le bouton Déployer est sur chaque ligne, toujours visible, jamais dans un
// menu — c'est la seule action qu'on vient faire ici.
//
// Les piles Compose vivent sur ce même écran, dans leur propre section : deux
// TYPES de déploiement, pas deux écrans.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { ConnectRepoDialog } from "@/components/connect-repo-dialog";
import { ConnectStackDialog } from "@/components/connect-stack-dialog";
import { DeploymentHistory } from "@/components/deployment-history";
import { type DraftVar, EnvVarTable } from "@/components/env-var-table";
import { LogStream } from "@/components/log-stream";
import { ServersPanel } from "@/components/servers-panel";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyTitle } from "@/components/ui/empty";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { WebhookPanel } from "@/components/webhook-panel";
import { authClient } from "@/lib/auth-client";
import {
  badgeVariant,
  dotClass,
  relativeTime,
  serviceLabel,
  shortSha,
} from "@/lib/format";
import { cn } from "@/lib/utils";
import { getAuthState } from "@/server/auth";
import {
  getDashboard,
  getDeployments,
  getStackDashboard,
  type ServiceRow,
  type StackRow,
} from "@/server/dashboard";
import { triggerDeploy, triggerRollback } from "@/server/deployments";
import { getEnvVars, saveEnvVars } from "@/server/env-vars";
import { getServers } from "@/server/servers";
import {
  getStackDeployments,
  triggerStackDeploy,
  triggerStackRollback,
} from "@/server/stacks";
import {
  generateServiceWebhook,
  generateStackWebhook,
  getServiceWebhook,
  getStackWebhook,
} from "@/server/webhooks";

interface DashboardSearch {
  deployment?: string;
  service?: string;
  stack?: string;
}

export const Route = createFileRoute("/")({
  beforeLoad: async () => {
    const state = await getAuthState();
    if (!state.signedIn) {
      throw redirect({ to: "/login" });
    }
    return { email: state.email };
  },
  component: Dashboard,
  loader: async ({ context }) => ({
    email: context.email,
    servers: await getServers(),
    services: await getDashboard(),
    stacks: await getStackDashboard(),
  }),
  validateSearch: (search: Record<string, unknown>): DashboardSearch => ({
    deployment:
      typeof search.deployment === "string" ? search.deployment : undefined,
    service: typeof search.service === "string" ? search.service : undefined,
    stack: typeof search.stack === "string" ? search.stack : undefined,
  }),
});

function Dashboard() {
  const { email, servers, services, stacks } = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const router = useRouter();

  const selectedService = services.find((s) => s.id === search.service) ?? null;
  const selectedStack = stacks.find((s) => s.id === search.stack) ?? null;

  const handleSignOut = useCallback(async () => {
    await authClient.signOut();
    await router.invalidate();
    await router.navigate({ to: "/login" });
  }, [router]);

  // Stables, et pris par les enfants qui y lient leur propre identifiant :
  // une fermeture créée dans le `.map()` en fabriquerait une nouvelle par
  // ligne à chaque rendu du dashboard.
  const handleToggleService = useCallback(
    (serviceId: string) =>
      navigate({
        search: {
          deployment: undefined,
          service: search.service === serviceId ? undefined : serviceId,
          stack: undefined,
        },
      }),
    [navigate, search.service]
  );

  const handleToggleStack = useCallback(
    (stackId: string) =>
      navigate({
        search: {
          deployment: undefined,
          service: undefined,
          stack: search.stack === stackId ? undefined : stackId,
        },
      }),
    [navigate, search.stack]
  );

  const handleFocusDeployment = useCallback(
    (serviceId: string, deploymentId: string) =>
      navigate({
        search: {
          deployment: deploymentId,
          service: serviceId,
          stack: undefined,
        },
      }),
    [navigate]
  );

  const handleFocusStackDeployment = useCallback(
    (stackId: string, deploymentId: string) =>
      navigate({
        search: {
          deployment: deploymentId,
          service: undefined,
          stack: stackId,
        },
      }),
    [navigate]
  );

  return (
    <main className="mx-auto max-w-5xl px-4 py-6">
      <header className="mb-6 flex items-center justify-between gap-4">
        <div className="flex items-baseline gap-3">
          <h1 className="font-medium text-lg tracking-tight">Noddle</h1>
          <span className="text-muted-foreground text-xs">
            {services.length} service{services.length > 1 ? "s" : ""}
            {stacks.length > 0
              ? ` · ${stacks.length} pile${stacks.length > 1 ? "s" : ""}`
              : ""}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-muted-foreground text-xs">{email}</span>
          <ConnectStackDialog servers={servers} />
          <ConnectRepoDialog servers={servers} />
          <Button onClick={handleSignOut} size="sm" variant="ghost">
            Se déconnecter
          </Button>
        </div>
      </header>

      {services.length === 0 && stacks.length === 0 ? (
        <Empty>
          <EmptyTitle>Aucun service</EmptyTitle>
          <EmptyDescription>
            Connectez un dépôt ou une pile Compose pour déployer votre premier
            service.
          </EmptyDescription>
        </Empty>
      ) : (
        <div className="flex flex-col gap-6">
          {services.length > 0 ? (
            <div className="flex flex-col gap-2">
              {services.map((service) => (
                <div className="flex flex-col gap-2" key={service.id}>
                  <ServiceCard
                    onToggle={handleToggleService}
                    selected={search.service === service.id}
                    service={service}
                  />
                  {search.service === service.id && selectedService ? (
                    <ServicePanel
                      focusedDeploymentId={search.deployment ?? null}
                      onFocusDeployment={handleFocusDeployment}
                      service={selectedService}
                    />
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}

          {stacks.length > 0 ? (
            <div className="flex flex-col gap-2">
              <h2 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
                Piles Compose
              </h2>
              {stacks.map((stack) => (
                <div className="flex flex-col gap-2" key={stack.id}>
                  <StackCard
                    onToggle={handleToggleStack}
                    selected={search.stack === stack.id}
                    stack={stack}
                  />
                  {search.stack === stack.id && selectedStack ? (
                    <StackPanel
                      focusedDeploymentId={search.deployment ?? null}
                      onFocusDeployment={handleFocusStackDeployment}
                      stack={selectedStack}
                    />
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      )}

      <ServersPanel initial={servers} />
    </main>
  );
}

function ServiceCard({
  onToggle,
  selected,
  service,
}: {
  onToggle: (serviceId: string) => void;
  selected: boolean;
  service: ServiceRow;
}) {
  const router = useRouter();
  const navigate = Route.useNavigate();
  const status = serviceLabel(service.status);

  const handleSelect = useCallback(
    () => onToggle(service.id),
    [onToggle, service.id]
  );

  const deploy = useMutation({
    mutationFn: () => triggerDeploy({ data: { serviceId: service.id } }),
    onSuccess: async (result) => {
      // On ouvre le flux de logs immédiatement. Le job vient d'être déposé ;
      // le worker n'a probablement pas encore écrit une ligne, et c'est
      // exactement pour ça que le flux commence par le tampon de rattrapage.
      await navigate({
        search: {
          deployment: result.deploymentId,
          service: service.id,
          stack: undefined,
        },
      });
      await router.invalidate();
    },
  });

  const handleDeploy = useCallback(() => deploy.mutate(), [deploy]);

  return (
    <Card className={cn("py-0", selected && "border-ring")}>
      <CardContent className="flex items-center gap-4 px-4 py-3">
        {/* `role="img"` : un span nu ne porte pas d'aria-label, et cette
            pastille est la réponse à « est-ce que ça tourne ? » pour qui ne
            distingue pas les couleurs. */}
        <span
          aria-label={status.label}
          className={cn("size-2 shrink-0 rounded-full", dotClass(status.tone))}
          role="img"
        />

        <button
          className="min-w-0 flex-1 text-start"
          onClick={handleSelect}
          type="button"
        >
          <span className="flex items-center gap-2 font-medium">
            {service.name}
            {service.watching ? (
              <Badge
                title="Surveillance post-déploiement en cours : Noddle observe encore ce service et reviendra en arrière s'il se met à boucler."
                variant="outline"
              >
                sous surveillance
              </Badge>
            ) : null}
          </span>
          <span className="block truncate text-muted-foreground text-xs">
            {service.project} / {service.environment} · {service.serverName}
            {service.domain ? ` · ${service.domain}` : ""}
          </span>
        </button>

        <div className="flex shrink-0 items-center gap-3">
          <Badge variant={badgeVariant(status.tone)}>{status.label}</Badge>

          <span className="hidden text-muted-foreground text-xs sm:inline">
            {service.lastDeployment
              ? `${shortSha(service.lastDeployment.commitSha)} · ${relativeTime(service.lastDeployment.createdAt)}`
              : "jamais déployé"}
          </span>

          <Button disabled={deploy.isPending} onClick={handleDeploy} size="sm">
            {deploy.isPending ? <Spinner data-icon="inline-start" /> : null}
            Déployer
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function ServicePanel({
  focusedDeploymentId,
  onFocusDeployment,
  service,
}: {
  focusedDeploymentId: string | null;
  onFocusDeployment: (serviceId: string, deploymentId: string) => void;
  service: ServiceRow;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [saveError, setSaveError] = useState<string | null>(null);

  const deployments = useQuery({
    queryFn: () => getDeployments({ data: { serviceId: service.id } }),
    queryKey: ["deployments", service.id],
  });

  const envVars = useQuery({
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
    (deploymentId: string) => onFocusDeployment(service.id, deploymentId),
    [onFocusDeployment, service.id]
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
  const shown = focusedDeploymentId ?? currentDeploymentId;

  return (
    <Card className="gap-0 py-0">
      <CardContent className="p-4">
        {shown ? (
          <LogStream deploymentId={shown} onEnd={handleEnd} />
        ) : (
          <p className="text-muted-foreground text-sm">
            Aucun déploiement : les logs apparaîtront au premier build.
          </p>
        )}
      </CardContent>

      <Separator />

      <CardContent className="p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="font-medium text-sm">Historique</h2>
          <span className="truncate text-muted-foreground text-xs">
            {service.gitRepoUrl ?? "—"}
            {service.gitBranch ? ` · ${service.gitBranch}` : ""}
          </span>
        </div>

        {deployments.data ? (
          <DeploymentHistory
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
      </CardContent>

      <Separator />

      <CardContent className="p-4">
        {envVars.data ? (
          <EnvVarTable
            // Remonte le tableau quand le serveur a confirmé : le brouillon
            // repart de l'état réellement enregistré, jamais de ce qu'on
            // croyait avoir envoyé.
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
      </CardContent>

      <Separator />

      <CardContent className="p-4">
        <WebhookPanel
          generateWebhook={handleGenerateWebhook}
          getWebhook={handleGetWebhook}
          queryKey={["webhook", "service", service.id]}
        />
      </CardContent>
    </Card>
  );
}

function StackCard({
  onToggle,
  selected,
  stack,
}: {
  onToggle: (stackId: string) => void;
  selected: boolean;
  stack: StackRow;
}) {
  const router = useRouter();
  const navigate = Route.useNavigate();
  const status = serviceLabel(stack.status);

  const handleSelect = useCallback(
    () => onToggle(stack.id),
    [onToggle, stack.id]
  );

  const deploy = useMutation({
    mutationFn: () => triggerStackDeploy({ data: { stackId: stack.id } }),
    onSuccess: async (result) => {
      await navigate({
        search: {
          deployment: result.stackDeploymentId,
          service: undefined,
          stack: stack.id,
        },
      });
      await router.invalidate();
    },
  });

  const handleDeploy = useCallback(() => deploy.mutate(), [deploy]);

  return (
    <Card className={cn("py-0", selected && "border-ring")}>
      <CardContent className="flex items-center gap-4 px-4 py-3">
        <span
          aria-label={status.label}
          className={cn("size-2 shrink-0 rounded-full", dotClass(status.tone))}
          role="img"
        />

        <button
          className="min-w-0 flex-1 text-start"
          onClick={handleSelect}
          type="button"
        >
          <span className="flex items-center gap-2 font-medium">
            {stack.name}
            {stack.watching ? (
              <Badge
                title="Surveillance post-déploiement en cours : Noddle observe encore cette pile et reviendra en arrière si un de ses services se met à boucler."
                variant="outline"
              >
                sous surveillance
              </Badge>
            ) : null}
          </span>
          <span className="block truncate text-muted-foreground text-xs">
            {stack.project} / {stack.environment} · {stack.serverName}
            {stack.publicService ? ` · ${stack.publicService}` : ""}
            {stack.domain ? ` · ${stack.domain}` : ""}
          </span>
        </button>

        <div className="flex shrink-0 items-center gap-3">
          <Badge variant={badgeVariant(status.tone)}>{status.label}</Badge>

          <span className="hidden text-muted-foreground text-xs sm:inline">
            {stack.lastDeployment
              ? `${shortSha(stack.lastDeployment.commitSha)} · ${relativeTime(stack.lastDeployment.createdAt)}`
              : "jamais déployée"}
          </span>

          <Button disabled={deploy.isPending} onClick={handleDeploy} size="sm">
            {deploy.isPending ? <Spinner data-icon="inline-start" /> : null}
            Déployer
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function StackPanel({
  focusedDeploymentId,
  onFocusDeployment,
  stack,
}: {
  focusedDeploymentId: string | null;
  onFocusDeployment: (stackId: string, deploymentId: string) => void;
  stack: StackRow;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();

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
    (deploymentId: string) => onFocusDeployment(stack.id, deploymentId),
    [onFocusDeployment, stack.id]
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
  const shown = focusedDeploymentId ?? currentDeploymentId;

  return (
    <Card className="gap-0 py-0">
      <CardContent className="p-4">
        {shown ? (
          <LogStream deploymentId={shown} onEnd={handleEnd} />
        ) : (
          <p className="text-muted-foreground text-sm">
            Aucun déploiement : les logs apparaîtront au premier build.
          </p>
        )}
      </CardContent>

      <Separator />

      <CardContent className="p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="font-medium text-sm">Historique</h2>
          <span className="truncate text-muted-foreground text-xs">
            {stack.gitRepoUrl} · {stack.gitBranch}
          </span>
        </div>

        {deployments.data ? (
          <DeploymentHistory
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
      </CardContent>

      <Separator />

      <CardContent className="p-4">
        <WebhookPanel
          generateWebhook={handleGenerateWebhook}
          getWebhook={handleGetWebhook}
          queryKey={["webhook", "stack", stack.id]}
        />
      </CardContent>
    </Card>
  );
}
