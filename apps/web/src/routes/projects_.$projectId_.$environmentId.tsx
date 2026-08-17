import { ArrowLeftIcon } from "@phosphor-icons/react";
import { createFileRoute, Link, notFound, redirect } from "@tanstack/react-router";
import { useCallback } from "react";

import { AppShell } from "@/components/app-shell";
import { EnvironmentSelector } from "@/components/environment-selector";
import { CreateServiceMenu } from "@/components/features/environment/create-service-menu";
import { ResourceGrid } from "@/components/features/environment/resource-grid";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { roles } from "@/lib/permissions";
import type { RoleName } from "@/lib/permissions";
import { getAuthState } from "@/server/auth";
import { getDashboardGroups, getEnvironmentScope } from "@/server/dashboard";
import { getProjectEnvironments } from "@/server/environments";
import { getProjects } from "@/server/projects";
import { getServers } from "@/server/servers";

export const Route = createFileRoute("/projects_/$projectId_/$environmentId")({
  beforeLoad: async () => {
    const state = await getAuthState();
    if (!state.signedIn) {
      throw redirect({ to: "/login" });
    }
    return { email: state.email, role: state.role };
  },
  component: ProjectEnvironmentPage,
  loader: async ({ context, params }) => {
    const [dashboard, allProjects, environments, servers] = await Promise.all([
      getDashboardGroups(),
      getProjects(),
      getProjectEnvironments({ data: { projectId: params.projectId } }),
      getServers(),
    ]);

    // EXISTENCE is read from `projects` and `environments`, never from the
    // dashboard's groups: those are built from SERVICES, so an empty
    // project doesn't appear there. Relying on them made a project you'd
    // just created render a 404 — measured in the browser, not deduced.
    const project = allProjects.find((p) => p.id === params.projectId);
    const current = environments.find((e) => e.id === params.environmentId);
    if (!(project && current)) {
      throw notFound();
    }

    const scope = await getEnvironmentScope({
      data: {
        environmentId: params.environmentId,
        projectId: params.projectId,
      },
    });

    // The group can legitimately be missing: it's only used to count what
    // sibling environments contain for the selector.
    const group = dashboard.groups.find((g) => g.projectId === params.projectId);

    return {
      counts: Object.fromEntries(
        environments.map((e) => {
          const s = group?.scopes.find((sc) => sc.environmentId === e.id);
          return [
            e.id,
            (s?.services.length ?? 0) + (s?.stacks.length ?? 0) + (s?.databases.length ?? 0),
          ];
        }),
      ),
      current,
      dashboard,
      email: context.email,
      environments,
      role: context.role,
      scope,
      servers,
    };
  },
});

function ProjectEnvironmentPage() {
  const { counts, current, dashboard, email, environments, role, scope, servers } =
    Route.useLoaderData();
  const { projectId } = Route.useParams();
  const navigate = Route.useNavigate();
  const known: RoleName | null = role && role in roles ? (role as RoleName) : null;

  const handleNavigate = useCallback(
    (environmentId: string) => {
      if (!environmentId) {
        navigate({ params: { projectId }, to: "/projects/$projectId" });
        return;
      }
      navigate({
        params: { environmentId, projectId },
        to: "/projects/$projectId/$environmentId",
      });
    },
    [navigate, projectId],
  );

  return (
    <AppShell
      actions={
        // THIS IS WHERE a service is created, and nowhere else: the project
        // and the environment are already known to the screen, so the
        // dialogs don't ask for them again. /deployments no longer carries
        // this action — it's a history, not an inventory.
        <CreateServiceMenu
          environmentName={scope.environment}
          projectName={scope.project}
          role={known}
          servers={servers}
        />
      }
      breadcrumb={
        <div className="flex min-w-0 items-center gap-2">
          <Button
            aria-label="Back to projects"
            className="-ms-1 shrink-0"
            nativeButton={false}
            render={<Link to="/projects" />}
            size="icon"
            variant="ghost"
          >
            <ArrowLeftIcon weight="regular" />
          </Button>
          <Breadcrumb className="min-w-0">
            <BreadcrumbList className="flex-nowrap">
              <BreadcrumbItem className="hidden sm:inline-flex">
                <BreadcrumbLink render={<Link to="/projects">Projects</Link>} />
              </BreadcrumbItem>
              <BreadcrumbSeparator className="hidden sm:block" />
              <BreadcrumbItem className="min-w-0">
                <span className="truncate font-medium">{scope.project}</span>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
          <EnvironmentSelector
            counts={counts}
            current={current}
            environments={environments}
            onNavigate={handleNavigate}
            projectId={projectId}
            role={known}
          />
        </div>
      }
      email={email}
      role={role}
      title={`${scope.project} / ${scope.environment}`}
    >
      <ResourceGrid
        environmentId={current.id}
        groups={dashboard.groups}
        initialScope={scope}
        projectId={projectId}
        role={known}
      />
    </AppShell>
  );
}
