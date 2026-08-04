// LE dashboard. Il n'y en a qu'un.
//
// Tout ce qui tourne, groupé par projet / environnement, chaque ligne
// répondant à « est-ce que ça tourne ? » sans lecture et portant son bouton
// Déployer — jamais dans un menu. Le contexte partagé (projet, environnement)
// vit dans le titre du groupe, pas répété sur chaque ligne : ce qui se répète
// n'informe plus.
//
// Le détail vit sur SA page (`/services/$id` et compagnie), pas déplié sous
// la ligne. Le dépliage faisait mille pixels et repoussait tous les autres
// services hors de l'écran — c'est-à-dire qu'il cassait la seule chose que
// ce dashboard doit faire. Ici, cliquer ne déplace jamais rien : on change
// de page, et la position de chaque ligne reste la même au retour.
import { CaretDownIcon, PlusIcon } from "@phosphor-icons/react";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";
import { AppShell, type ScopeLink } from "@/components/app-shell";
import { AttachDatabaseDialog } from "@/components/attach-database-dialog";
import { ConnectDatabaseDialog } from "@/components/connect-database-dialog";
import { ConnectRepoDialog } from "@/components/connect-repo-dialog";
import { ConnectStackDialog } from "@/components/connect-stack-dialog";
import { ResourceRow, RowGroup } from "@/components/resource-row";
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
import { relativeTime, serviceLabel, shortSha } from "@/lib/format";
import { type RoleName, roles } from "@/lib/permissions";
import { useCan } from "@/lib/use-permission";
import { getAuthState } from "@/server/auth";
import {
  getDashboard,
  getStackDashboard,
  type ServiceRow,
  type StackRow,
} from "@/server/dashboard";
import { type DatabaseRow, getDatabaseDashboard } from "@/server/databases";
import { triggerDeploy } from "@/server/deployments";
import { getServers } from "@/server/servers";
import { triggerStackDeploy } from "@/server/stacks";

// Plus aucun paramètre de recherche ici : ce que l'on regarde vit
// désormais dans le CHEMIN d'une page de détail, pas dans la requête du
// dashboard.
export const Route = createFileRoute("/")({
  beforeLoad: async () => {
    const state = await getAuthState();
    if (!state.signedIn) {
      throw redirect({ to: "/login" });
    }
    return { email: state.email, role: state.role };
  },
  component: Dashboard,
  loader: async ({ context }) => ({
    databases: await getDatabaseDashboard(),
    email: context.email,
    role: context.role,
    servers: await getServers(),
    services: await getDashboard(),
    stacks: await getStackDashboard(),
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
  const { databases, email, role, servers, services, stacks } =
    Route.useLoaderData();
  const navigate = Route.useNavigate();

  // Résolu UNE fois ici, transmis tel quel : chaque bouton du dashboard
  // appelle `useCan` avec la MÊME valeur plutôt que de refaire ce calcul,
  // pour qu'aucune ligne n'évalue un rôle différent des autres.
  const known: RoleName | null =
    role && role in roles ? (role as RoleName) : null;
  const canCreateService = useCan(known, "service", "create");
  const canCreateDatabase = useCan(known, "database", "create");

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

  // Ouvrir un détail est une NAVIGATION, pas un dépliage : la liste
  // derrière ne bouge pas, et l'URL dit ce qu'on regarde.
  const openService = useCallback(
    (serviceId: string) =>
      navigate({ params: { serviceId }, to: "/services/$serviceId" }),
    [navigate]
  );

  const openStackDetail = useCallback(
    (stackId: string) =>
      navigate({ params: { stackId }, to: "/stacks/$stackId" }),
    [navigate]
  );

  const openDatabaseDetail = useCallback(
    (databaseId: string) =>
      navigate({ params: { databaseId }, to: "/databases/$databaseId" }),
    [navigate]
  );

  const empty = scopes.length === 0;

  const canCreateAnything = canCreateService || canCreateDatabase;

  return (
    <AppShell
      actions={
        canCreateAnything ? (
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button size="sm" />}>
              <PlusIcon data-icon="inline-start" />
              New
              <CaretDownIcon data-icon="inline-end" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {canCreateService ? (
                <DropdownMenuItem onClick={openRepo}>
                  Git repository
                </DropdownMenuItem>
              ) : null}
              {canCreateService ? (
                <DropdownMenuItem onClick={openStack}>
                  Compose stack
                </DropdownMenuItem>
              ) : null}
              {canCreateDatabase ? (
                <DropdownMenuItem onClick={openDatabase}>
                  Database
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null
      }
      email={email}
      scopes={scopeLinks}
      title="Deployments"
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
          <EmptyTitle>Nothing deployed yet</EmptyTitle>
          <EmptyDescription>
            {servers.length === 0
              ? "Add a server first, then connect a repository."
              : "Connect a repository, a Compose stack or a database to get started."}
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
                <ServiceCard
                  key={service.id}
                  onOpen={openService}
                  role={known}
                  service={service}
                />
              ))}

              {scope.stacks.map((stack) => (
                <StackCard
                  key={stack.id}
                  onOpen={openStackDetail}
                  role={known}
                  stack={stack}
                />
              ))}

              {scope.databases.map((database) => (
                <DatabaseCard
                  database={database}
                  key={database.id}
                  onOpen={openDatabaseDetail}
                  role={known}
                  services={services}
                />
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
function ServiceCard({
  onOpen,
  role,
  service,
}: {
  onOpen: (serviceId: string) => void;
  role: RoleName | null;
  service: ServiceRow;
}) {
  const navigate = Route.useNavigate();
  const status = serviceLabel(service.status);
  const canDeploy = useCan(role, "service", "deploy");

  const handleSelect = useCallback(
    () => onOpen(service.id),
    [onOpen, service.id]
  );

  const deploy = useMutation({
    mutationFn: () => triggerDeploy({ data: { serviceId: service.id } }),
    onSuccess: async (result) => {
      // On part sur la page du service, flux de logs ouvert. Le job vient
      // d'être déposé ; le worker n'a probablement pas encore écrit une
      // ligne, et c'est exactement pour ça que le flux commence par le
      // tampon de rattrapage.
      await navigate({
        params: { serviceId: service.id },
        search: { deployment: result.deploymentId },
        to: "/services/$serviceId",
      });
    },
  });

  const handleDeploy = useCallback(() => deploy.mutate(), [deploy]);

  return (
    <ResourceRow
      action={
        canDeploy ? (
          <Button disabled={deploy.isPending} onClick={handleDeploy} size="sm">
            {deploy.isPending ? <Spinner data-icon="inline-start" /> : null}
            Deploy
          </Button>
        ) : null
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
      tag={
        service.watching ? (
          <Badge
            title="Post-deploy watch running: Noddle is still observing this service and will roll it back if it starts crash-looping."
            variant="outline"
          >
            watching
          </Badge>
        ) : null
      }
      tone={status.tone}
      toneLabel={status.label}
    />
  );
}

function StackCard({
  onOpen,
  role,
  stack,
}: {
  onOpen: (stackId: string) => void;
  role: RoleName | null;
  stack: StackRow;
}) {
  const navigate = Route.useNavigate();
  const status = serviceLabel(stack.status);
  const canDeploy = useCan(role, "service", "deploy");

  const handleSelect = useCallback(() => onOpen(stack.id), [onOpen, stack.id]);

  const deploy = useMutation({
    mutationFn: () => triggerStackDeploy({ data: { stackId: stack.id } }),
    onSuccess: async (result) => {
      await navigate({
        params: { stackId: stack.id },
        search: { deployment: result.stackDeploymentId },
        to: "/stacks/$stackId",
      });
    },
  });

  const handleDeploy = useCallback(() => deploy.mutate(), [deploy]);

  return (
    <ResourceRow
      action={
        canDeploy ? (
          <Button disabled={deploy.isPending} onClick={handleDeploy} size="sm">
            {deploy.isPending ? <Spinner data-icon="inline-start" /> : null}
            Deploy
          </Button>
        ) : null
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
          <span className="text-muted-foreground/70">stack · </span>
          {stack.serverName}
          {stack.domain ? ` · ${stack.domain}` : ""}
        </>
      }
      tag={
        stack.watching ? (
          <Badge
            title="Post-deploy watch running: Noddle is still observing this stack and will roll it back if any of its services starts crash-looping."
            variant="outline"
          >
            watching
          </Badge>
        ) : null
      }
      tone={status.tone}
      toneLabel={status.label}
    />
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
  onOpen,
  role,
  services,
}: {
  database: DatabaseRow;
  onOpen: (databaseId: string) => void;
  role: RoleName | null;
  services: ServiceRow[];
}) {
  const status = serviceLabel(database.status);
  const canAttach = useCan(role, "database", "attach");
  const handleSelect = useCallback(
    () => onOpen(database.id),
    [database.id, onOpen]
  );

  return (
    <ResourceRow
      action={
        canAttach ? (
          <AttachDatabaseDialog
            databaseId={database.id}
            defaultKey={DEFAULT_ENV_VAR_KEY[database.engine]}
            services={services}
          />
        ) : null
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
