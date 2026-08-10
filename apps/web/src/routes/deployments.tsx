import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import type { ChangeEvent } from "react";
import { useCallback, useMemo, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { RelativeTime } from "@/components/relative-time";
import { Badge } from "@/components/ui/badge";
import { Empty, EmptyDescription, EmptyTitle } from "@/components/ui/empty";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@/components/ui/frame";
import { Input } from "@/components/ui/input";
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
import {
  type DeploymentLogRow,
  getDashboardGroups,
  getDeploymentLog,
} from "@/server/dashboard";

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
    () => [...new Set(log.map((d) => d.status))].sort(),
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

  return (
    <AppShell email={email} role={role} title="Deployments">
      <Frame variant="ghost">
        <FrameHeader>
          <FrameTitle>Deployments</FrameTitle>
          <FrameDescription>
            Every application and compose deployment, most recent first.
            Creating a service happens in its environment, not here.
          </FrameDescription>
        </FrameHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              aria-label="Search deployments"
              className="min-w-56 flex-1"
              onChange={handleSearchChange}
              placeholder="Search by name, project, environment, server…"
              value={search}
            />
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
          </div>

          {visible.length === 0 ? (
            <Empty className="h-full">
              <EmptyTitle>No deployments found</EmptyTitle>
              <EmptyDescription>
                {log.length === 0
                  ? "Deployments from applications and compose will appear here."
                  : "Try a different search or filter."}
              </EmptyDescription>
            </Empty>
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
        </div>
      </Frame>
    </AppShell>
  );
}

function DeploymentLogLine({ row }: { row: DeploymentLogRow }) {
  const label = deploymentLabel(row.status);
  return (
    <TableRow>
      <TableCell className="font-medium">
        {/* The link targets the RESOURCE, not the deployment: it's its page
            that carries the history and the logs. */}
        {row.kind === "service" ? (
          <Link
            className="hover:underline"
            params={{
              environmentId: row.environmentId,
              projectId: row.projectId,
              serviceId: row.resourceId,
            }}
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
