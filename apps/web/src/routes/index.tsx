import {
  ArrowRightIcon,
  CheckCircleIcon,
  CubeIcon,
  FolderIcon,
  PulseIcon,
  RocketLaunchIcon,
} from "@phosphor-icons/react";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { AppShell } from "@/components/app-shell";
import { RelativeTime } from "@/components/relative-time";
import { StatusSummary } from "@/components/status-summary";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Frame,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@/components/ui/frame";
import { Status, StatusIndicator, StatusLabel } from "@/components/ui/status";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { deploymentLabel, serviceLabel } from "@/lib/format";
import { getAuthState } from "@/server/auth";
import { getOverview } from "@/server/dashboard";
import type { Overview } from "@/server/dashboard";

export const Route = createFileRoute("/")({
  beforeLoad: async () => {
    const state = await getAuthState();
    if (!state.signedIn) {
      throw redirect({ to: "/login" });
    }
    return { email: state.email, role: state.role };
  },
  component: OverviewPage,
  loader: async ({ context }) => ({
    email: context.email,
    overview: await getOverview(),
    role: context.role,
  }),
});

function OverviewPage() {
  const { email, overview, role } = Route.useLoaderData();
  const { activity, attention, statusCounts } = overview;
  const nothingAtAll = Object.keys(statusCounts).length === 0;

  return (
    <AppShell
      actions={
        nothingAtAll ? null : (
          <Button nativeButton={false} render={<Link to="/projects" />}>
            Go to projects
            <ArrowRightIcon data-icon="inline-end" weight="regular" />
          </Button>
        )
      }
      email={email}
      role={role}
      title="Overview"
    >
      <div className="flex min-w-0 flex-col gap-4">
        <StatCards counts={overview.counts} statusCounts={statusCounts} />
        <AttentionPanel idle={nothingAtAll} rows={attention} />
        <ActivityPanel rows={activity} />
      </div>
    </AppShell>
  );
}

function StatCards({
  counts,
  statusCounts,
}: {
  counts: Overview["counts"];
  statusCounts: Record<string, number>;
}) {
  const hasStatus = Object.values(statusCounts).some((n) => n > 0);

  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <StatCard icon={FolderIcon} label="Projects">
        <StatNumber
          detail={`${counts.environments} environment${counts.environments === 1 ? "" : "s"}`}
          value={counts.projects}
        />
      </StatCard>
      <StatCard icon={CubeIcon} label="Resources">
        <StatNumber
          detail={`${counts.services} application${counts.services === 1 ? "" : "s"} · ${counts.stacks} compose · ${counts.databases} database${counts.databases === 1 ? "" : "s"}`}
          value={counts.services + counts.stacks + counts.databases}
        />
      </StatCard>
      <StatCard icon={RocketLaunchIcon} label="Deploys">
        <StatNumber
          detail={counts.deploys7d === 0 ? "No activity yet" : "Last 7 days"}
          value={counts.deploys7d}
        />
      </StatCard>
      <StatCard icon={PulseIcon} label="Status">
        {hasStatus ? (
          <StatusSummary counts={statusCounts} />
        ) : (
          <p className="text-muted-foreground text-sm">No resources yet</p>
        )}
      </StatCard>
    </div>
  );
}

function StatCard({
  children,
  icon: Icon,
  label,
}: {
  children: ReactNode;
  icon: typeof FolderIcon;
  label: string;
}) {
  return (
    <Frame spacing="sm" variant="ghost">
      <FrameHeader className="flex-row items-center gap-1.5 text-muted-foreground">
        <Icon aria-hidden="true" className="size-3.5 shrink-0" weight="fill" />
        <FrameTitle className="font-medium text-xs uppercase tracking-wide">
          {label}
        </FrameTitle>
      </FrameHeader>
      <FramePanel>{children}</FramePanel>
    </Frame>
  );
}

function StatNumber({ detail, value }: { detail: string; value: number }) {
  return (
    <>
      <p className="font-semibold text-3xl tabular-nums">{value}</p>
      <p className="mt-1 truncate text-muted-foreground text-xs">{detail}</p>
    </>
  );
}

function AttentionPanel({
  idle,
  rows,
}: {
  idle: boolean;
  rows: Overview["attention"];
}) {
  return (
    <Frame className="min-w-0" variant="ghost">
      <FrameHeader>
        <FrameTitle>Needs attention</FrameTitle>
      </FrameHeader>
      {rows.length === 0 ? (
        <FramePanel className="flex items-center gap-2 text-muted-foreground text-sm">
          {idle ? (
            "Nothing to report."
          ) : (
            <>
              <CheckCircleIcon className="size-4 shrink-0" weight="fill" />
              Everything is running.
            </>
          )}
        </FramePanel>
      ) : (
        rows.map((row) => <AttentionRow key={row.id} row={row} />)
      )}
    </Frame>
  );
}

function AttentionRow({ row }: { row: Overview["attention"][number] }) {
  const status = serviceLabel(row.status);

  return (
    <FramePanel className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="flex min-w-0 items-center gap-2 font-medium text-sm">
          <AttentionLink row={row}>{row.name}</AttentionLink>
          <span className="truncate font-normal text-muted-foreground text-xs">
            {row.scope}
          </span>
        </p>
        {row.detail ? (
          <p className="mt-1 text-destructive text-sm">{row.detail}</p>
        ) : null}
      </div>
      <Status tone={status.tone}>
        <StatusIndicator />
        <StatusLabel>{status.label}</StatusLabel>
      </Status>
    </FramePanel>
  );
}

function AttentionLink({
  children,
  row,
}: {
  children: ReactNode;
  row: Overview["attention"][number];
}) {
  const className = "truncate after:absolute after:inset-0 after:z-10";
  const params = {
    environmentId: row.environmentId,
    projectId: row.projectId,
  };

  if (row.kind === "service") {
    return (
      <Link
        className={className}
        params={{ ...params, serviceId: row.id }}
        to="/projects/$projectId/$environmentId/services/$serviceId"
      >
        {children}
      </Link>
    );
  }

  if (row.kind === "stack") {
    return (
      <Link
        className={className}
        params={{ ...params, stackId: row.id }}
        to="/projects/$projectId/$environmentId/stacks/$stackId"
      >
        {children}
      </Link>
    );
  }

  return (
    <Link
      className={className}
      params={{ ...params, databaseId: row.id }}
      to="/projects/$projectId/$environmentId/databases/$databaseId"
    >
      {children}
    </Link>
  );
}

function ActivityPanel({ rows }: { rows: Overview["activity"] }) {
  const empty = rows.length === 0;

  return (
    <Frame className="min-w-0" variant="ghost">
      <FrameHeader className="flex-row items-center justify-between gap-3">
        <FrameTitle>Recent deployments</FrameTitle>
        <Button
          nativeButton={false}
          render={<Link to="/deployments" />}
          variant="ghost"
        >
          View all
          <ArrowRightIcon data-icon="inline-end" weight="regular" />
        </Button>
      </FrameHeader>
      <FramePanel className={empty ? undefined : "p-0"}>
        {empty ? (
          <Empty className="border-0">
            <EmptyTitle>Nothing deployed yet</EmptyTitle>
            <EmptyDescription>
              Connect a repository, a Compose stack or a database to get
              started.
            </EmptyDescription>
            <EmptyContent>
              <Button nativeButton={false} render={<Link to="/projects" />}>
                Get started
                <ArrowRightIcon data-icon="inline-end" weight="regular" />
              </Button>
            </EmptyContent>
          </Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Resource</TableHead>
                <TableHead>Environment</TableHead>
                <TableHead>Deployed</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                const status = deploymentLabel(row.status);
                return (
                  <TableRow key={row.id}>
                    <TableCell className="font-medium">
                      <Link
                        className="hover:underline"
                        params={{
                          environmentId: row.environmentId,
                          projectId: row.projectId,
                          serviceId: row.serviceId,
                        }}
                        search={{ deployment: row.id, tab: "deployments" }}
                        to="/projects/$projectId/$environmentId/services/$serviceId"
                      >
                        {row.serviceName}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {row.project} / {row.environment}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      <RelativeTime iso={row.createdAt} />
                    </TableCell>
                    <TableCell>
                      <Status tone={status.tone}>
                        <StatusIndicator />
                        <StatusLabel>{status.label}</StatusLabel>
                      </Status>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </FramePanel>
    </Frame>
  );
}
