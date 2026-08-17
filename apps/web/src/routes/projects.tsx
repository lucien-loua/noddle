import { CodeIcon, DatabaseIcon, StackIcon, TreeStructureIcon } from "@phosphor-icons/react";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { useMemo } from "react";

import { AppShell } from "@/components/app-shell";
import { CreateProjectButton, ProjectRowActions } from "@/components/project-actions";
import { RelativeTime } from "@/components/relative-time";
import { StatusSummary } from "@/components/status-summary";
import { Empty, EmptyDescription, EmptyTitle } from "@/components/ui/empty";
import {
  Frame,
  FrameDescription,
  FrameFooter,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@/components/ui/frame";
import { roles } from "@/lib/permissions";
import type { RoleName } from "@/lib/permissions";
import { getAuthState } from "@/server/auth";
import { getDashboardGroups } from "@/server/dashboard";
import type { ProjectGroup } from "@/server/dashboard";
import { getProjects } from "@/server/projects";
import type { ProjectView } from "@/server/projects";

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
    const [dashboard, allProjects] = await Promise.all([getDashboardGroups(), getProjects()]);
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
  const known: RoleName | null = role && role in roles ? (role as RoleName) : null;

  const byId = useMemo(
    () => new Map(dashboard.groups.map((g) => [g.projectId, g])),
    [dashboard.groups],
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
            A project groups environments, and an environment holds your services, stacks and
            databases.
          </EmptyDescription>
        </Empty>
      ) : (
        // Same track as the environment grid: the column count follows the
        // room available, not three breakpoints. `auto-fill` keeps a lone
        // project from stretching across the row, and `min(100%, …)` keeps
        // the floor from overflowing a phone.
        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,clamp(16rem,28vw,22rem)),1fr))] gap-4">
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

function ProjectCount({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof CodeIcon;
  label: string;
  value: number;
}) {
  if (value === 0) {
    return null;
  }
  return (
    <span className="flex items-center gap-1.5 text-sm">
      <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <span className="font-medium tabular-nums">{value}</span>
      <span className="text-muted-foreground">{label}</span>
    </span>
  );
}

function ProjectCard({
  group,
  project,
  role,
}: {
  /** Absent = an EMPTY project: it exists, it simply has nothing in it
   *  yet. This isn't missing data, and the card says so in words rather
   *  than with a dash. */
  group: ProjectGroup | undefined;
  project: ProjectView;
  role: RoleName | null;
}) {
  const scopes = group?.scopes ?? [];
  const services = scopes.reduce((n, s) => n + s.services.length, 0);
  const stacks = scopes.reduce((n, s) => n + s.stacks.length, 0);
  const databases = scopes.reduce((n, s) => n + s.databases.length, 0);
  const environments = scopes.length;
  const deployed = group ? Object.values(group.statusCounts).reduce((n, c) => n + c, 0) : 0;

  // Same three tiers as a resource card: the header says WHICH project,
  // the panel says WHAT IS IN IT and how it is doing, the footer says HOW
  // OLD and HOW MANY ENVIRONMENTS. Nothing is stated twice — a total would
  // repeat what the two panel rows already add up to.
  return (
    <Frame className="group transition-shadow hover:shadow-lg">
      <FrameHeader>
        <div className="flex items-start gap-2">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <FrameTitle className="min-w-0 truncate">
              {/* Stretched link: the whole card navigates, without nesting
                  the menu inside a clickable block — same pattern as
                  `features/environment/resource-grid.tsx`. `z-10` so it
                  also covers the panel and the footer, which are
                  positioned and come later in the DOM. */}
              <Link
                className="truncate after:absolute after:inset-0 after:z-10"
                params={{ projectId: project.id }}
                to="/projects/$projectId"
              >
                {project.name}
              </Link>
            </FrameTitle>
            {project.description ? (
              <FrameDescription className="line-clamp-2">{project.description}</FrameDescription>
            ) : null}
          </div>
          {/* `z-20`: stay above the title's stretched `::after`. */}
          <div className="relative z-20 shrink-0">
            <ProjectRowActions
              description={project.description}
              name={project.name}
              projectId={project.id}
              role={role}
            />
          </div>
        </div>
      </FrameHeader>
      <FramePanel className="flex flex-col gap-3">
        {deployed > 0 && group ? (
          <StatusSummary counts={group.statusCounts} />
        ) : (
          <p className="text-muted-foreground text-sm">No resources yet</p>
        )}
        {/* Same shape as `StatusSummary` — icon, number, word — so the
            two rows read as one system, and same rule: only what is
            actually there. The statuses say HOW the resources are, this
            says WHAT they are; the total appears in neither, because the
            two rows already add up to it. The glyphs are the ones the
            resource grid uses for the same three things. */}
        {services + stacks + databases > 0 ? (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
            <ProjectCount
              icon={CodeIcon}
              label={services === 1 ? "app" : "apps"}
              value={services}
            />
            <ProjectCount icon={StackIcon} label="compose" value={stacks} />
            <ProjectCount icon={DatabaseIcon} label="db" value={databases} />
          </div>
        ) : null}
      </FramePanel>
      <FrameFooter>
        <p className="flex flex-wrap items-center gap-x-1.5 text-muted-foreground text-xs">
          {/* `z-20`: the card's stretched link sits at `z-10` and would
              otherwise take the hover, so the tooltip would never open. */}
          <span>
            Created <RelativeTime className="relative z-20" iso={project.createdAt} long />
          </span>
          <span aria-hidden>·</span>
          <span className="flex items-center gap-1.5">
            <TreeStructureIcon aria-hidden className="size-3.5 shrink-0" />
            {environments} environment{environments === 1 ? "" : "s"}
          </span>
        </p>
      </FrameFooter>
    </Frame>
  );
}
