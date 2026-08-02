// LE dashboard. Il n'y en a qu'un.
//
// Tous les services d'un coup d'œil, avec leur statut et leur dernier
// déploiement. Sélectionner un service ouvre son détail SOUS la ligne, sans
// quitter l'écran : c'est ce que veut dire « pas de page vue d'ensemble
// séparée ». La sélection vit dans l'URL, donc un état précis se partage.
//
// Le bouton Déployer est sur chaque ligne, toujours visible, jamais dans un
// menu — c'est la seule action qu'on vient faire ici.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { useCallback, useState } from "react";
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
  type ServiceRow,
} from "@/server/dashboard";
import { triggerDeploy, triggerRollback } from "@/server/deployments";
import { getEnvVars, saveEnvVars } from "@/server/env-vars";
import { getServers } from "@/server/servers";

interface DashboardSearch {
  deployment?: string;
  service?: string;
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
  }),
  validateSearch: (search: Record<string, unknown>): DashboardSearch => ({
    deployment:
      typeof search.deployment === "string" ? search.deployment : undefined,
    service: typeof search.service === "string" ? search.service : undefined,
  }),
});

function Dashboard() {
  const { email, servers, services } = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const router = useRouter();

  const selected = services.find((s) => s.id === search.service) ?? null;

  const handleSignOut = useCallback(async () => {
    await authClient.signOut();
    await router.invalidate();
    await router.navigate({ to: "/login" });
  }, [router]);

  // Stables, et pris par les enfants qui y lient leur propre identifiant :
  // une fermeture créée dans le `.map()` en fabriquerait une nouvelle par
  // service à chaque rendu du dashboard.
  const handleToggle = useCallback(
    (serviceId: string) =>
      navigate({
        search: {
          deployment: undefined,
          service: search.service === serviceId ? undefined : serviceId,
        },
      }),
    [navigate, search.service]
  );

  const handleFocusDeployment = useCallback(
    (serviceId: string, deploymentId: string) =>
      navigate({ search: { deployment: deploymentId, service: serviceId } }),
    [navigate]
  );

  return (
    <main className="mx-auto max-w-5xl px-4 py-6">
      <header className="mb-6 flex items-center justify-between gap-4">
        <div className="flex items-baseline gap-3">
          <h1 className="font-medium text-lg tracking-tight">Noddle</h1>
          <span className="text-muted-foreground text-xs">
            {services.length} service{services.length > 1 ? "s" : ""}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-muted-foreground text-xs">{email}</span>
          <Button onClick={handleSignOut} size="sm" variant="ghost">
            Se déconnecter
          </Button>
        </div>
      </header>

      {services.length === 0 ? (
        <Empty>
          <EmptyTitle>Aucun service</EmptyTitle>
          <EmptyDescription>
            L'installateur enregistre la machine hôte comme serveur cible n°1 ;
            les services s'ajoutent ensuite.
          </EmptyDescription>
        </Empty>
      ) : (
        <div className="flex flex-col gap-2">
          {services.map((service) => (
            <div className="flex flex-col gap-2" key={service.id}>
              <ServiceCard
                onToggle={handleToggle}
                selected={search.service === service.id}
                service={service}
              />
              {search.service === service.id && selected ? (
                <ServicePanel
                  focusedDeploymentId={search.deployment ?? null}
                  onFocusDeployment={handleFocusDeployment}
                  service={selected}
                />
              ) : null}
            </div>
          ))}
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
        search: { deployment: result.deploymentId, service: service.id },
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
    </Card>
  );
}
