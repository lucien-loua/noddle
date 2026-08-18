import { MagnifyingGlassIcon, RocketLaunchIcon } from "@phosphor-icons/react";
import {
  createFileRoute,
  Link,
  redirect,
  useNavigate,
} from "@tanstack/react-router";
import type { ChangeEvent } from "react";
import { useCallback, useMemo, useState } from "react";

import { AppShell } from "@/components/app-shell";
import { IconStack } from "@/components/icon-stack";
import { RelativeTime } from "@/components/relative-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@/components/ui/frame";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { badgeVariant, deploymentLabel, shortSha } from "@/lib/format";
import { getAuthState } from "@/server/auth";
import { getDashboardGroups, getDeploymentLog } from "@/server/dashboard";
import type { DeploymentLogRow } from "@/server/dashboard";

type TypeFilter = "all" | "service" | "stack";

export const Route = createFileRoute("/deployments")({
  beforeLoad: async () => {
    const state = await getAuthState();
    if (!state.signedIn) {
      throw redirect({ to: "/login" });
    }
    return { email: state.email, role: state.role };
  },
  component: DeploymentsPage,
  loader: async ({ context }) => {
    const [dashboard, log] = await Promise.all([
      getDashboardGroups(),
      getDeploymentLog(),
    ]);
    return { dashboard, email: context.email, log, role: context.role };
  },
});

function DeploymentsPage() {
  const { email, log, role } = Route.useLoaderData();

  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [type, setType] = useState<TypeFilter>("all");

  const statuses = useMemo(
    () => [...new Set(log.map((d) => d.status))].toSorted(),
    [log]
  );

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return log.filter((d) => {
      if (type !== "all" && d.kind !== type) {
        return false;
      }
      if (status !== "all" && d.status !== status) {
        return false;
      }
      if (!q) {
        return true;
      }
      // The four columns a search of this kind covers: "name, project,
      // environment, server".
      return (
        d.name.toLowerCase().includes(q) ||
        d.project.toLowerCase().includes(q) ||
        d.environment.toLowerCase().includes(q) ||
        d.serverName.toLowerCase().includes(q)
      );
    });
  }, [log, search, status, type]);

  const handleSearchChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => setSearch(e.target.value),
    []
  );
  const handleStatusChange = useCallback(
    (next: unknown) => setStatus(next as string),
    []
  );
  const handleTypeChange = useCallback(
    (next: unknown) => setType(next as TypeFilter),
    []
  );

  const filtering = search.trim() !== "" || status !== "all" || type !== "all";
  const clearFilters = useCallback(() => {
    setSearch("");
    setStatus("all");
    setType("all");
  }, []);

  return (
    <AppShell email={email} role={role} title="Deployments">
      {/* `stacked`: the filter bar and the table are one object — a
          toolbar over its content — not two cards that happen to sit above
          each other. Every panel below is therefore a DIRECT child, which
          is what the join is keyed on. */}
      <Frame className="flex h-full min-h-0 flex-col" stacked variant="ghost">
        <FrameHeader>
          <FrameTitle className="flex items-center gap-2">
            Deployments
            <Badge variant="outline">
              {filtering ? `${visible.length} of ${log.length}` : log.length}
            </Badge>
          </FrameTitle>
          <FrameDescription>
            Every application and compose deployment, most recent first.
            Creating a service happens in its environment, not here.
          </FrameDescription>
        </FrameHeader>

        {/* No filter bar over an empty log: three controls that can only
            ever narrow nothing down to nothing. */}
        {log.length > 0 ? (
          <FramePanel className="flex flex-wrap items-center gap-2">
            <InputGroup className="min-w-56 flex-1">
              <InputGroupAddon>
                <MagnifyingGlassIcon />
              </InputGroupAddon>
              <InputGroupInput
                aria-label="Search deployments"
                onChange={handleSearchChange}
                placeholder="Search by name, project, environment, server…"
                value={search}
              />
            </InputGroup>
            <Select
              items={Object.fromEntries([
                ["all", "All statuses"],
                ...statuses.map((s) => [s, deploymentLabel(s).label]),
              ])}
              onValueChange={handleStatusChange}
              value={status}
            >
              <SelectTrigger aria-label="Filter by status" className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="all">All statuses</SelectItem>
                  {statuses.map((s) => (
                    <SelectItem key={s} value={s}>
                      {deploymentLabel(s).label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <Select
              items={{
                all: "All types",
                service: "Applications",
                stack: "Compose",
              }}
              onValueChange={handleTypeChange}
              value={type}
            >
              <SelectTrigger aria-label="Filter by type" className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="all">All types</SelectItem>
                  <SelectItem value="service">Applications</SelectItem>
                  <SelectItem value="stack">Compose</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
            {filtering ? (
              <Button onClick={clearFilters} size="sm" variant="ghost">
                Clear
              </Button>
            ) : null}
          </FramePanel>
        ) : null}

        {/* The two empty states are NOT the same event, so they do not get
            the same way out: filtered to nothing is undone by clearing the
            filters, while nothing ever deployed is undone somewhere else
            entirely — this page cannot start a deployment, and saying so
            with a link beats a sentence that leaves you here. */}
        {visible.length === 0 ? (
          <FramePanel className="flex min-h-0 flex-1 flex-col">
            <Empty className="min-h-0 flex-1 border-0">
              <EmptyHeader>
                <EmptyMedia>
                  <IconStack>
                    {filtering ? (
                      <MagnifyingGlassIcon className="size-5" />
                    ) : (
                      <RocketLaunchIcon className="size-5" />
                    )}
                  </IconStack>
                </EmptyMedia>
                <EmptyTitle>
                  {filtering ? "No deployments match" : "No deployments yet"}
                </EmptyTitle>
                <EmptyDescription>
                  {filtering
                    ? "No deployment matches this search and these filters."
                    : "Deployments from applications and compose appear here. They start from a service, in its environment."}
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                {filtering ? (
                  <Button onClick={clearFilters} variant="outline">
                    Clear filters
                  </Button>
                ) : (
                  <Button nativeButton={false} render={<Link to="/projects" />}>
                    Go to projects
                  </Button>
                )}
              </EmptyContent>
            </Empty>
          </FramePanel>
        ) : (
          // `p-0`: the table already carries its own cell margins, and
          // the panel should only frame it — same composition as
          // `audit-table.tsx`.
          <FramePanel className="p-0">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Service</TableHead>
                  <TableHead>Project</TableHead>
                  <TableHead>Environment</TableHead>
                  <TableHead>Server</TableHead>
                  <TableHead className="w-24">Commit</TableHead>
                  <TableHead className="w-32">Status</TableHead>
                  <TableHead className="w-32">Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((d) => (
                  <DeploymentLogLine key={`${d.kind}:${d.id}`} row={d} />
                ))}
              </TableBody>
            </Table>
          </FramePanel>
        )}
      </Frame>
    </AppShell>
  );
}

/**
 * A row goes to THIS deployment, not to the service that owns it.
 *
 * The resource's page already reads `?deployment=<id>` and opens that
 * build's logs, so the row can land on the exact thing it names — one step
 * instead of "open the service, find the tab, find the line again". The
 * name stays a real link so middle-click and "open in new tab" work; the
 * row's own handler is what makes the other six cells clickable, which
 * they were not.
 */
function DeploymentLogLine({ row }: { row: DeploymentLogRow }) {
  const label = deploymentLabel(row.status);
  const navigate = useNavigate();

  const handleRowClick = useCallback(() => {
    if (row.kind === "service") {
      navigate({
        params: {
          environmentId: row.environmentId,
          projectId: row.projectId,
          serviceId: row.resourceId,
        },
        search: { deployment: row.id, tab: "deployments" },
        to: "/projects/$projectId/$environmentId/services/$serviceId",
      });
      return;
    }
    navigate({
      params: {
        environmentId: row.environmentId,
        projectId: row.projectId,
        stackId: row.resourceId,
      },
      search: { deployment: row.id, tab: "history" },
      to: "/projects/$projectId/$environmentId/stacks/$stackId",
    });
  }, [navigate, row]);

  return (
    <TableRow className="cursor-pointer" onClick={handleRowClick}>
      <TableCell className="font-medium">
        {row.kind === "service" ? (
          <Link
            className="hover:underline"
            params={{
              environmentId: row.environmentId,
              projectId: row.projectId,
              serviceId: row.resourceId,
            }}
            search={{ deployment: row.id, tab: "deployments" }}
            to="/projects/$projectId/$environmentId/services/$serviceId"
          >
            {row.name}
          </Link>
        ) : (
          <Link
            className="hover:underline"
            params={{
              environmentId: row.environmentId,
              projectId: row.projectId,
              stackId: row.resourceId,
            }}
            search={{ deployment: row.id, tab: "history" }}
            to="/projects/$projectId/$environmentId/stacks/$stackId"
          >
            {row.name}
          </Link>
        )}
      </TableCell>
      <TableCell className="text-muted-foreground">{row.project}</TableCell>
      <TableCell className="text-muted-foreground">{row.environment}</TableCell>
      <TableCell className="text-muted-foreground">{row.serverName}</TableCell>
      <TableCell className="font-mono text-muted-foreground text-xs">
        {shortSha(row.commitSha)}
      </TableCell>
      <TableCell>
        <Badge variant={badgeVariant(label.tone)}>{label.label}</Badge>
      </TableCell>
      <TableCell className="text-muted-foreground">
        <RelativeTime iso={row.createdAt} />
      </TableCell>
    </TableRow>
  );
}
