import {
  ArrowRightIcon,
  MagnifyingGlassIcon,
  RocketLaunchIcon,
  XIcon,
} from "@phosphor-icons/react";
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
import { Status, StatusIndicator, StatusLabel } from "@/components/ui/status";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { deploymentLabel, shortSha } from "@/lib/format";
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
      {log.length === 0 ? (
        <Frame className="flex h-full min-h-0 flex-col" variant="ghost">
          <FramePanel className="flex min-h-0 flex-1 flex-col">
            <Empty className="min-h-0 flex-1 border-0">
              <EmptyHeader>
                <EmptyMedia>
                  <IconStack>
                    <RocketLaunchIcon className="size-5" />
                  </IconStack>
                </EmptyMedia>
                <EmptyTitle>No deployments yet</EmptyTitle>
                <EmptyDescription>
                  Deployments from applications and Compose stacks appear here.
                  Start one from a resource, in its environment.
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button nativeButton={false} render={<Link to="/projects" />}>
                  Go to projects
                  <ArrowRightIcon data-icon="inline-end" weight="regular" />
                </Button>
              </EmptyContent>
            </Empty>
          </FramePanel>
        </Frame>
      ) : (
        <Frame className="w-full" variant="ghost">
          <FrameHeader className="gap-3">
            <div>
              <FrameTitle className="flex items-center gap-2">
                All projects
                <Badge variant="outline">
                  {filtering
                    ? `${visible.length} of ${log.length}`
                    : log.length}
                </Badge>
              </FrameTitle>
              <FrameDescription>
                Every application and compose deployment, most recent first.
                Creating a service happens in its environment, not here.
              </FrameDescription>
            </div>

            <div className="flex flex-wrap items-center gap-2">
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
            </div>
          </FrameHeader>

          {visible.length === 0 ? (
            <FramePanel className="flex min-h-0 flex-1 flex-col">
              <Empty className="min-h-0 flex-1 border-0">
                <EmptyHeader>
                  <EmptyMedia>
                    <IconStack>
                      <MagnifyingGlassIcon className="size-5" />
                    </IconStack>
                  </EmptyMedia>
                  <EmptyTitle>No deployments match</EmptyTitle>
                  <EmptyDescription>
                    Try a different search or filter.
                  </EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                  <Button onClick={clearFilters} variant="outline">
                    <XIcon data-icon="inline-start" weight="regular" />
                    Clear filters
                  </Button>
                </EmptyContent>
              </Empty>
            </FramePanel>
          ) : (
            <FramePanel className="p-0">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Resource</TableHead>
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
      )}
    </AppShell>
  );
}

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
        <Status tone={label.tone}>
          <StatusIndicator />
          <StatusLabel>{label.label}</StatusLabel>
        </Status>
      </TableCell>
      <TableCell className="text-muted-foreground">
        <RelativeTime iso={row.createdAt} />
      </TableCell>
    </TableRow>
  );
}
