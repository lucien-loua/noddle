import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { useMemo } from "react";
import { AppShell } from "@/components/app-shell";
import {
  CreateProjectButton,
  ProjectRowActions,
} from "@/components/project-actions";
import { StatusSummary } from "@/components/status-summary";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyTitle } from "@/components/ui/empty";
import { type RoleName, roles } from "@/lib/permissions";
import { getAuthState } from "@/server/auth";
import { getDashboardGroups, type ProjectGroup } from "@/server/dashboard";
import { getProjects, type ProjectView } from "@/server/projects";

export const Route = createFileRoute("/projects")({
  beforeLoad: async () => {
    const state = await getAuthState();
    if (!state.signedIn) {
      throw redirect({ to: "/login" });
    }
    return { email: state.email, role: state.role };
  },
  component: ProjectsPage,
  loader: async ({ context }) => {
    const [dashboard, allProjects] = await Promise.all([
      getDashboardGroups(),
      getProjects(),
    ]);
    return {
      allProjects,
      dashboard,
      email: context.email,
      role: context.role,
    };
  },
});

function ProjectsPage() {
  const { allProjects, dashboard, email, role } = Route.useLoaderData();
  const known: RoleName | null =
    role && role in roles ? (role as RoleName) : null;

  const byId = useMemo(
    () => new Map(dashboard.groups.map((g) => [g.projectId, g])),
    [dashboard.groups]
  );

  return (
    <AppShell
      actions={<CreateProjectButton role={known} />}
      email={email}
      role={role}
      title="Projects"
    >
      {allProjects.length === 0 ? (
        <Empty className="h-full">
          <EmptyTitle>No projects yet</EmptyTitle>
          <EmptyDescription>
            A project groups environments, and an environment holds your
            services, stacks and databases.
          </EmptyDescription>
        </Empty>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {allProjects.map((project) => (
            <ProjectCard
              group={byId.get(project.id)}
              key={project.id}
              project={project}
              role={known}
            />
          ))}
        </div>
      )}
    </AppShell>
  );
}

function ProjectCard({
  group,
  project,
  role,
}: {
  /** Absent = an EMPTY project: it exists, it simply has nothing in it yet.
   *  This isn't missing data, and the card says so with zeros rather than
   *  a dash. */
  group: ProjectGroup | undefined;
  project: ProjectView;
  role: RoleName | null;
}) {
  const scopes = group?.scopes ?? [];
  const services = scopes.reduce((n, s) => n + s.services.length, 0);
  const stacks = scopes.reduce((n, s) => n + s.stacks.length, 0);
  const databases = scopes.reduce((n, s) => n + s.databases.length, 0);
  const environments = scopes.length;

  return (
    <Card className="group relative transition-shadow hover:shadow-lg">
      <CardHeader>
        <CardTitle className="min-w-0 truncate">
          {/* Stretched link: the whole card navigates, without nesting the
              menu inside a clickable block — same pattern as
              `features/environment/resource-grid.tsx`. */}
          <Link
            className="truncate after:absolute after:inset-0"
            params={{ projectId: project.id }}
            to="/projects/$projectId"
          >
            {project.name}
          </Link>
        </CardTitle>
        {project.description ? (
          <CardDescription className="line-clamp-2">
            {project.description}
          </CardDescription>
        ) : null}
        {/* `z-10`: stay above the title's stretched `::after`. `row-span-1`
            when there is no description — CardAction's default `row-span-2`
            would otherwise invent an empty second row. */}
        <CardAction
          className={
            project.description ? "relative z-10" : "relative z-10 row-span-1"
          }
        >
          <ProjectRowActions
            description={project.description}
            name={project.name}
            projectId={project.id}
            role={role}
          />
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-muted-foreground text-sm">
          {environments} environment{environments === 1 ? "" : "s"} · {services}{" "}
          app{services === 1 ? "" : "s"} · {stacks} compose · {databases} db
        </p>
        {group ? <StatusSummary counts={group.statusCounts} /> : null}
      </CardContent>
    </Card>
  );
}
