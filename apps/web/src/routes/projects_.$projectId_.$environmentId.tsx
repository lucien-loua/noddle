import { ArrowLeftIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import {
  createFileRoute,
  Link,
  notFound,
  redirect,
} from "@tanstack/react-router";
import { useCallback, useEffect } from "react";

import { AppShell } from "@/components/app-shell";
import { EnvironmentSelector } from "@/components/environment-selector";
import { CreateServiceMenu } from "@/components/features/environment/create-service-menu";
import { ResourceGrid } from "@/components/features/environment/resource-grid";
import { EnvironmentTopology } from "@/components/features/environment/topology";
import { TabRail } from "@/components/tab-rail";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsTrigger } from "@/components/ui/tabs";
import {
  readEnvironmentView,
  writeEnvironmentView,
} from "@/lib/environment-view";
import { roles } from "@/lib/permissions";
import type { RoleName } from "@/lib/permissions";
import { queries } from "@/lib/queries";
import { ActiveTabPanel } from "@/lib/resource-detail/active-tab";
import { DETAIL_TAB_PANEL_CLASS } from "@/lib/resource-detail/constants";
import { getAuthState } from "@/server/auth";
import { getDashboardGroups, getEnvironmentScope } from "@/server/dashboard";
import { getProjectEnvironments } from "@/server/environments";
import { getProjects } from "@/server/projects";
import { getServers } from "@/server/servers";

export const Route = createFileRoute("/projects_/$projectId_/$environmentId")({
  // Only the non-default view is carried. `?view=resources` would be a URL
  // that says nothing, and the detail pages already drop their default tab.
  validateSearch: (search: Record<string, unknown>): { view?: "topology" } =>
    search.view === "topology" ? { view: "topology" } : {},
  beforeLoad: async () => {
    const state = await getAuthState();
    if (!state.signedIn) {
      throw redirect({ to: "/login" });
    }
    return { email: state.email, role: state.role };
  },
  component: ProjectEnvironmentPage,
  loader: async ({ context, params }) => {
    // The scope joins the others rather than waiting for the 404 guard below:
    // it reads `params` only. On a route that does not exist this fetches one
    // thing for nothing; on every route that does, it saved a round trip.
    const [dashboard, allProjects, environments, servers, scope] =
      await Promise.all([
        getDashboardGroups(),
        getProjects(),
        getProjectEnvironments({ data: { projectId: params.projectId } }),
        getServers(),
        getEnvironmentScope({
          data: {
            environmentId: params.environmentId,
            projectId: params.projectId,
          },
        }),
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

    // The group can legitimately be missing: it's only used to count what
    // sibling environments contain for the selector.
    const group = dashboard.groups.find(
      (g) => g.projectId === params.projectId
    );

    return {
      counts: Object.fromEntries(
        environments.map((e) => {
          const s = group?.scopes.find((sc) => sc.environmentId === e.id);
          return [
            e.id,
            (s?.services.length ?? 0) +
              (s?.stacks.length ?? 0) +
              (s?.databases.length ?? 0),
          ];
        })
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
  const {
    counts,
    current,
    dashboard,
    email,
    environments,
    role,
    scope,
    servers,
  } = Route.useLoaderData();
  const { projectId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const known: RoleName | null =
    role && role in roles ? (role as RoleName) : null;
  const scopeQuery = useQuery({
    ...queries.environmentScope(projectId, current.id),
    initialData: scope,
  });
  const liveScope = scopeQuery.data ?? scope;
  const emptyInventory =
    liveScope.services.length === 0 &&
    liveScope.stacks.length === 0 &&
    liveScope.databases.length === 0;

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
    [navigate, projectId]
  );

  const view = search.view ?? "resources";

  const handleViewChange = useCallback(
    (value: string) => {
      writeEnvironmentView(value === "topology" ? "topology" : "resources");
      navigate({
        replace: true,
        search: value === "topology" ? { view: "topology" } : {},
      });
    },
    [navigate]
  );

  // Restores the last view when the URL carries none — the case of coming
  // back from a resource opened out of the graph, where the breadcrumb points
  // at the environment with no search. An effect, not a render-time read:
  // see `environment-view.ts`.
  useEffect(() => {
    if (!search.view && readEnvironmentView() === "topology") {
      navigate({ replace: true, search: { view: "topology" } });
    }
  }, [navigate, search.view]);

  const createMenu = (
    <CreateServiceMenu
      align={emptyInventory ? "center" : "end"}
      environmentName={scope.environment}
      projectName={scope.project}
      role={known}
      servers={servers}
    />
  );

  return (
    <AppShell
      actions={emptyInventory ? null : createMenu}
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
      {emptyInventory ? (
        // No rail on an empty environment: two tabs above a single empty
        // state offer a choice between nothing and nothing.
        <ResourceGrid
          createAction={createMenu}
          environmentId={current.id}
          groups={dashboard.groups}
          initialScope={scope}
          projectId={projectId}
          role={known}
        />
      ) : (
        <Tabs
          // `h-full`, not `flex-1`: the shell's content area is a SCROLL box
          // in `display: block`, so a flex child has nothing to grow into.
          // With a height, each panel below can own its overflow — the
          // resources scroll, the canvas fills what is left.
          className="flex h-full min-h-0 flex-col gap-3"
          onValueChange={handleViewChange}
          value={view}
        >
          <TabRail>
            <TabsTrigger value="resources">Resources</TabsTrigger>
            <TabsTrigger value="topology">Topology</TabsTrigger>
          </TabRail>
          {/* Base UI keeps EVERY panel mounted, so without `ActiveTabPanel`
              the grid stays on screen under the canvas — and keeps polling
              its scope every two seconds while you look at the graph. */}
          <TabsContent className={DETAIL_TAB_PANEL_CLASS} value="resources">
            <ActiveTabPanel active={view} value="resources">
              <ResourceGrid
                environmentId={current.id}
                groups={dashboard.groups}
                initialScope={scope}
                projectId={projectId}
                role={known}
              />
            </ActiveTabPanel>
          </TabsContent>
          <TabsContent
            className="flex min-h-0 flex-1 flex-col data-ending-style:hidden"
            value="topology"
          >
            <ActiveTabPanel active={view} value="topology">
              <EnvironmentTopology scope={liveScope} />
            </ActiveTabPanel>
          </TabsContent>
        </Tabs>
      )}
    </AppShell>
  );
}
