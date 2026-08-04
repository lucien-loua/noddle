// LE dashboard. Il n'y en a qu'un.
//
// Tout ce qui tourne, groupé par projet / environnement, chaque ligne
// répondant à « est-ce que ça tourne ? » sans lecture et portant son bouton
// Déployer — jamais dans un menu. Le contexte partagé (projet, environnement)
// vit dans le titre du groupe, pas répété sur chaque ligne : ce qui se répète
// n'informe plus.
//
// Le détail s'ouvre SOUS la ligne, dans le même conteneur, en onglets. Empilé,
// il faisait mille pixels et repoussait tous les autres services hors de
// l'écran — c'est-à-dire qu'il cassait la seule chose que ce dashboard doit
// faire.
import { CaretDownIcon, PlusIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";
import { AppShell, type ScopeLink } from "@/components/app-shell";
import { AttachDatabaseDialog } from "@/components/attach-database-dialog";
import { BackupPanel, RestoreDialog } from "@/components/backup-panel";
import { ConnectDatabaseDialog } from "@/components/connect-database-dialog";
import { ConnectRepoDialog } from "@/components/connect-repo-dialog";
import { ConnectStackDialog } from "@/components/connect-stack-dialog";
import { DeploymentHistory } from "@/components/deployment-history";
import { type DraftVar, EnvVarTable } from "@/components/env-var-table";
import { LogStream } from "@/components/log-stream";
import { ResourceRow, RowGroup } from "@/components/resource-row";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Empty, EmptyDescription, EmptyTitle } from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { WebhookPanel } from "@/components/webhook-panel";
import { relativeTime, serviceLabel, shortSha } from "@/lib/format";
import { getAuthState } from "@/server/auth";
import { type BackupRow, triggerRestore } from "@/server/backups";
import {
  getDashboard,
  getDeployments,
  getStackDashboard,
  type ServiceRow,
  type StackRow,
} from "@/server/dashboard";
import { type DatabaseRow, getDatabaseDashboard } from "@/server/databases";
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
  /** La base dépliée. Même mécanique que `service`/`stack` : le détail vit
   *  dans l'URL, donc il survit à un rechargement et se partage. */
  database?: string;
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
    databases: await getDatabaseDashboard(),
    email: context.email,
    servers: await getServers(),
    services: await getDashboard(),
    stacks: await getStackDashboard(),
  }),
  validateSearch: (search: Record<string, unknown>): DashboardSearch => ({
    database: typeof search.database === "string" ? search.database : undefined,
    deployment:
      typeof search.deployment === "string" ? search.deployment : undefined,
    service: typeof search.service === "string" ? search.service : undefined,
    stack: typeof search.stack === "string" ? search.stack : undefined,
  }),
});

/** Clé de groupe : ce que les lignes d'un même groupe ont en commun, et donc
 *  ce qu'elles n'ont plus à répéter chacune. */
function scopeKey(project: string, environment: string): string {
  return `${project}/${environment}`;
}

interface Scope {
  databases: DatabaseRow[];
  environment: string;
  project: string;
  services: ServiceRow[];
  stacks: StackRow[];
}

function buildScopes(
  services: ServiceRow[],
  stacks: StackRow[],
  databases: DatabaseRow[]
): Scope[] {
  const map = new Map<string, Scope>();
  const ensure = (project: string, environment: string): Scope => {
    const key = scopeKey(project, environment);
    const found = map.get(key);
    if (found) {
      return found;
    }
    const created: Scope = {
      databases: [],
      environment,
      project,
      services: [],
      stacks: [],
    };
    map.set(key, created);
    return created;
  };

  for (const s of services) {
    ensure(s.project, s.environment).services.push(s);
  }
  for (const s of stacks) {
    ensure(s.project, s.environment).stacks.push(s);
  }
  for (const d of databases) {
    ensure(d.project, d.environment).databases.push(d);
  }

  return [...map.values()].sort((a, b) =>
    scopeKey(a.project, a.environment).localeCompare(
      scopeKey(b.project, b.environment)
    )
  );
}

function Dashboard() {
  const { databases, email, servers, services, stacks } = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  const [dialog, setDialog] = useState<"database" | "repo" | "stack" | null>(
    null
  );
  const closeDialog = useCallback((open: boolean) => {
    if (!open) {
      setDialog(null);
    }
  }, []);
  const openRepo = useCallback(() => setDialog("repo"), []);
  const openStack = useCallback(() => setDialog("stack"), []);
  const openDatabase = useCallback(() => setDialog("database"), []);

  const scopes = useMemo(
    () => buildScopes(services, stacks, databases),
    [services, stacks, databases]
  );

  const scopeLinks: ScopeLink[] = useMemo(
    () =>
      scopes.map((s) => ({
        environment: s.environment,
        key: scopeKey(s.project, s.environment),
        project: s.project,
      })),
    [scopes]
  );

  const selectedService = services.find((s) => s.id === search.service) ?? null;
  const selectedStack = stacks.find((s) => s.id === search.stack) ?? null;

  const handleToggleService = useCallback(
    (serviceId: string) =>
      navigate({
        search: {
          database: undefined,
          deployment: undefined,
          service: search.service === serviceId ? undefined : serviceId,
          stack: undefined,
        },
      }),
    [navigate, search.service]
  );

  const handleToggleDatabase = useCallback(
    (databaseId: string) =>
      navigate({
        search: {
          database: search.database === databaseId ? undefined : databaseId,
          deployment: undefined,
          service: undefined,
          stack: undefined,
        },
      }),
    [navigate, search.database]
  );

  const handleToggleStack = useCallback(
    (stackId: string) =>
      navigate({
        search: {
          database: undefined,
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

  const empty = scopes.length === 0;

  return (
    <AppShell
      actions={
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button size="sm" />}>
            <PlusIcon data-icon="inline-start" />
            Nouveau
            <CaretDownIcon data-icon="inline-end" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={openRepo}>Dépôt Git</DropdownMenuItem>
            <DropdownMenuItem onClick={openStack}>
              Pile Compose
            </DropdownMenuItem>
            <DropdownMenuItem onClick={openDatabase}>
              Base de données
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      }
      email={email}
      scopes={scopeLinks}
      title="Déploiements"
    >
      <ConnectRepoDialog
        onOpenChange={closeDialog}
        open={dialog === "repo"}
        servers={servers}
      />
      <ConnectStackDialog
        onOpenChange={closeDialog}
        open={dialog === "stack"}
        servers={servers}
      />
      <ConnectDatabaseDialog
        onOpenChange={closeDialog}
        open={dialog === "database"}
        servers={servers}
      />

      {empty ? (
        <Empty>
          <EmptyTitle>Rien de déployé</EmptyTitle>
          <EmptyDescription>
            {servers.length === 0
              ? "Ajoutez d'abord un serveur, puis connectez un dépôt."
              : "Connectez un dépôt, une pile Compose ou une base de données pour commencer."}
          </EmptyDescription>
        </Empty>
      ) : (
        <div className="flex min-w-0 flex-col gap-6">
          {scopes.map((scope) => (
            <RowGroup
              id={scopeKey(scope.project, scope.environment)}
              key={scopeKey(scope.project, scope.environment)}
              title={
                <>
                  {scope.project}
                  <span className="text-muted-foreground/50"> / </span>
                  {scope.environment}
                </>
              }
            >
              {scope.services.map((service) => (
                <div key={service.id}>
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

              {scope.stacks.map((stack) => (
                <div key={stack.id}>
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

              {scope.databases.map((database) => (
                <div key={database.id}>
                  <DatabaseCard
                    database={database}
                    onToggle={handleToggleDatabase}
                    selected={search.database === database.id}
                    services={services}
                  />
                  {search.database === database.id ? (
                    <DatabasePanel database={database} />
                  ) : null}
                </div>
              ))}
            </RowGroup>
          ))}
        </div>
      )}
    </AppShell>
  );
}

/** Le panneau de détail, dans le MÊME conteneur que sa ligne : un panneau
 *  flottant à côté ne dirait pas à quoi il appartient. */
function DetailPanel({ children }: { children: React.ReactNode }) {
  return <div className="border-t bg-muted/20 px-3 py-3">{children}</div>;
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
    <ResourceRow
      action={
        <Button disabled={deploy.isPending} onClick={handleDeploy} size="sm">
          {deploy.isPending ? <Spinner data-icon="inline-start" /> : null}
          Déployer
        </Button>
      }
      meta={
        service.lastDeployment
          ? `${shortSha(service.lastDeployment.commitSha)} · ${relativeTime(service.lastDeployment.createdAt)}`
          : null
      }
      name={service.name}
      onToggle={handleSelect}
      secondary={
        <>
          {service.serverName}
          {service.domain ? ` · ${service.domain}` : ""}
        </>
      }
      selected={selected}
      tag={
        service.watching ? (
          <Badge
            title="Surveillance post-déploiement en cours : Noddle observe encore ce service et reviendra en arrière s'il se met à boucler."
            variant="outline"
          >
            sous surveillance
          </Badge>
        ) : null
      }
      tone={status.tone}
      toneLabel={status.label}
    />
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
    <DetailPanel>
      <Tabs defaultValue="logs">
        {/* Le rail défile dans SON conteneur : à 320 px, « Webhook » sortait
            de l'écran et devenait inatteignable — mesuré. */}
        <TabsList
          className="scroll-fade-x no-scrollbar max-w-full overflow-x-auto"
          variant="line"
        >
          <TabsTrigger value="logs">Logs</TabsTrigger>
          <TabsTrigger value="history">Historique</TabsTrigger>
          <TabsTrigger value="env">Variables</TabsTrigger>
          <TabsTrigger value="webhook">Webhook</TabsTrigger>
        </TabsList>

        <TabsContent className="pt-3" value="logs">
          {shown ? (
            <LogStream deploymentId={shown} onEnd={handleEnd} />
          ) : (
            <p className="text-muted-foreground text-sm">
              Aucun déploiement : les logs apparaîtront au premier build.
            </p>
          )}
        </TabsContent>

        <TabsContent className="pt-3" value="history">
          <p className="mb-2 truncate text-muted-foreground text-xs">
            {service.gitRepoUrl ?? "—"}
            {service.gitBranch ? ` · ${service.gitBranch}` : ""}
          </p>
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
        </TabsContent>

        <TabsContent className="pt-3" value="env">
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
        </TabsContent>

        <TabsContent className="pt-3" value="webhook">
          <WebhookPanel
            generateWebhook={handleGenerateWebhook}
            getWebhook={handleGetWebhook}
            queryKey={["webhook", "service", service.id]}
          />
        </TabsContent>
      </Tabs>
    </DetailPanel>
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
    <ResourceRow
      action={
        <Button disabled={deploy.isPending} onClick={handleDeploy} size="sm">
          {deploy.isPending ? <Spinner data-icon="inline-start" /> : null}
          Déployer
        </Button>
      }
      meta={
        stack.lastDeployment
          ? `${shortSha(stack.lastDeployment.commitSha)} · ${relativeTime(stack.lastDeployment.createdAt)}`
          : null
      }
      name={stack.name}
      onToggle={handleSelect}
      secondary={
        <>
          <span className="text-muted-foreground/70">pile · </span>
          {stack.serverName}
          {stack.domain ? ` · ${stack.domain}` : ""}
        </>
      }
      selected={selected}
      tag={
        stack.watching ? (
          <Badge
            title="Surveillance post-déploiement en cours : Noddle observe encore cette pile et reviendra en arrière si un de ses services se met à boucler."
            variant="outline"
          >
            sous surveillance
          </Badge>
        ) : null
      }
      tone={status.tone}
      toneLabel={status.label}
    />
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
    <DetailPanel>
      <Tabs defaultValue="logs">
        {/* Le rail défile dans SON conteneur : à 320 px, « Webhook » sortait
            de l'écran et devenait inatteignable — mesuré. */}
        <TabsList
          className="scroll-fade-x no-scrollbar max-w-full overflow-x-auto"
          variant="line"
        >
          <TabsTrigger value="logs">Logs</TabsTrigger>
          <TabsTrigger value="history">Historique</TabsTrigger>
          <TabsTrigger value="webhook">Webhook</TabsTrigger>
        </TabsList>

        <TabsContent className="pt-3" value="logs">
          {shown ? (
            <LogStream deploymentId={shown} onEnd={handleEnd} />
          ) : (
            <p className="text-muted-foreground text-sm">
              Aucun déploiement : les logs apparaîtront au premier build.
            </p>
          )}
        </TabsContent>

        <TabsContent className="pt-3" value="history">
          <p className="mb-2 truncate text-muted-foreground text-xs">
            {stack.gitRepoUrl} · {stack.gitBranch}
          </p>
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
        </TabsContent>

        <TabsContent className="pt-3" value="webhook">
          <WebhookPanel
            generateWebhook={handleGenerateWebhook}
            getWebhook={handleGetWebhook}
            queryKey={["webhook", "stack", stack.id]}
          />
        </TabsContent>
      </Tabs>
    </DetailPanel>
  );
}

const DEFAULT_ENV_VAR_KEY: Record<DatabaseRow["engine"], string> = {
  postgres: "DATABASE_URL",
  redis: "REDIS_URL",
};

const ENGINE_LABEL: Record<DatabaseRow["engine"], string> = {
  postgres: "PostgreSQL",
  redis: "Redis",
};

function DatabaseCard({
  database,
  onToggle,
  selected,
  services,
}: {
  database: DatabaseRow;
  onToggle: (databaseId: string) => void;
  selected: boolean;
  services: ServiceRow[];
}) {
  const status = serviceLabel(database.status);
  const handleSelect = useCallback(
    () => onToggle(database.id),
    [database.id, onToggle]
  );

  return (
    <ResourceRow
      action={
        <AttachDatabaseDialog
          databaseId={database.id}
          defaultKey={DEFAULT_ENV_VAR_KEY[database.engine]}
          services={services}
        />
      }
      name={database.name}
      onToggle={handleSelect}
      secondary={
        <>
          <span className="text-muted-foreground/70">
            {ENGINE_LABEL[database.engine]} ·{" "}
          </span>
          {database.serverName}
        </>
      }
      selected={selected}
      tone={status.tone}
      toneLabel={status.label}
    />
  );
}

/**
 * Le détail d'une base : ses sauvegardes.
 *
 * Un seul onglet aujourd'hui, donc pas d'onglets — un `TabsList` d'un seul
 * élément est du décor. Le jour où une base en aura un second, il ressemblera
 * à celui d'un service.
 */
function DatabasePanel({ database }: { database: DatabaseRow }) {
  const [target, setTarget] = useState<BackupRow | null>(null);
  const restore = useMutation({
    mutationFn: (confirmName: string) =>
      triggerRestore({
        data: {
          backupId: target?.id ?? "",
          confirmName,
          databaseId: database.id,
        },
      }),
    onSuccess: () => setTarget(null),
  });

  const handleClose = useCallback((open: boolean) => {
    if (!open) {
      setTarget(null);
    }
  }, []);
  const handleConfirm = useCallback(
    (confirmName: string) => restore.mutate(confirmName),
    [restore]
  );

  return (
    <div className="border-t bg-muted/20 px-3 py-3">
      <BackupPanel
        databaseId={database.id}
        databaseName={database.name}
        onRestore={setTarget}
        retention={database.backupRetention}
        schedule={database.backupSchedule}
      />
      {restore.isError ? (
        <Alert className="mt-3" variant="destructive">
          <AlertDescription>
            {restore.error instanceof Error
              ? restore.error.message
              : "restauration refusée"}
          </AlertDescription>
        </Alert>
      ) : null}
      <RestoreDialog
        backup={target}
        databaseName={database.name}
        onConfirm={handleConfirm}
        onOpenChange={handleClose}
        pending={restore.isPending}
      />
    </div>
  );
}
