import { ArrowRightIcon, CheckCircleIcon } from "@phosphor-icons/react";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";
import { RelativeTime } from "@/components/relative-time";
import { StatusSummary } from "@/components/status-summary";
import { Badge } from "@/components/ui/badge";
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
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@/components/ui/item";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { badgeVariant, deploymentLabel, serviceLabel } from "@/lib/format";
import { getAuthState } from "@/server/auth";
import { getOverview, type Overview } from "@/server/dashboard";

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
        <Button nativeButton={false} render={<Link to="/deployments" />}>
          View all
          <ArrowRightIcon data-icon="inline-end" />
        </Button>
      }
      email={email}
      role={role}
      title="Overview"
    >
      {nothingAtAll ? (
        <Empty className="h-full">
          <EmptyTitle>Nothing deployed yet</EmptyTitle>
          <EmptyDescription>
            Connect a repository, a Compose stack or a database to get started.
          </EmptyDescription>
          <EmptyContent>
            <Button nativeButton={false} render={<Link to="/deployments" />}>
              Get started
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <div className="flex min-w-0 flex-col gap-6">
          <StatCards counts={overview.counts} statusCounts={statusCounts} />
          <AttentionPanel rows={attention} />
          <ActivityPanel rows={activity} />
        </div>
      )}
    </AppShell>
  );
}

/**
 * The four numbers that situate the installation, in a card grid.
 *
 * Each carries ONE number readable from afar and a detail line below it —
 * never two numbers of equal weight in the same card, or you no longer know
 * which is the subject. The last one is a deliberate exception: "status"
 * has no total that would mean anything ("4 things"?), so it renders the
 * breakdown itself.
 */
function StatCards({
  counts,
  statusCounts,
}: {
  counts: Overview["counts"];
  statusCounts: Record<string, number>;
}) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatCard
        detail={`${counts.environments} environment${counts.environments === 1 ? "" : "s"}`}
        label="Projects"
        value={counts.projects}
      />
      <StatCard
        detail={`${counts.services} app${counts.services === 1 ? "" : "s"} · ${counts.stacks} compose · ${counts.databases} db`}
        label="Services"
        value={counts.services + counts.stacks + counts.databases}
      />
      <StatCard
        detail={counts.deploys7d === 0 ? "no activity yet" : "last 7 days"}
        label="Deploys"
        value={counts.deploys7d}
      />
      <div className="rounded-2xl border bg-card p-3">
        <p className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
          Status
        </p>
        <div className="mt-2">
          <StatusSummary counts={statusCounts} />
        </div>
      </div>
    </div>
  );
}

function StatCard({
  detail,
  label,
  value,
}: {
  detail: string;
  label: string;
  value: number;
}) {
  return (
    <div className="rounded-2xl border bg-card p-3">
      <p className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        {label}
      </p>
      <p className="mt-1 font-semibold text-3xl tabular-nums">{value}</p>
      <p className="mt-1 truncate text-muted-foreground text-xs">{detail}</p>
    </div>
  );
}

/**
 * What isn't running.
 *
 * When the list is empty, we SAY so instead of hiding the section: "nothing
 * to report" is information, and a section that disappears leaves doubt
 * about what it would have shown.
 */
function AttentionPanel({ rows }: { rows: Overview["attention"] }) {
  return (
    <section className="min-w-0">
      <h2 className="mb-2 px-1 font-semibold text-foreground text-sm">
        Needs attention
      </h2>

      {rows.length === 0 ? (
        <div className="flex items-center gap-2 rounded-2xl border bg-card px-3 py-3 text-muted-foreground text-sm">
          <CheckCircleIcon className="size-4 shrink-0" weight="fill" />
          Everything is running.
        </div>
      ) : (
        // `render`: `Item` then applies hover and focus to the anchor
        // itself, rather than to a wrapping container.
        <ItemGroup>
          {rows.map((row) => {
            const status = serviceLabel(row.status);
            return (
              <Item
                key={row.id}
                render={<Link to={row.href} />}
                size="sm"
                variant="outline"
              >
                <ItemContent>
                  <ItemTitle>
                    {row.name}
                    <span className="font-normal text-muted-foreground text-xs">
                      {row.scope}
                    </span>
                  </ItemTitle>
                  {row.detail ? (
                    <ItemDescription className="text-destructive">
                      {row.detail}
                    </ItemDescription>
                  ) : null}
                </ItemContent>
                <ItemActions>
                  <Badge variant={badgeVariant(status.tone)}>
                    {status.label}
                  </Badge>
                </ItemActions>
              </Item>
            );
          })}
        </ItemGroup>
      )}
    </section>
  );
}

/** The last ten deployments, across all services. */
function ActivityPanel({ rows }: { rows: Overview["activity"] }) {
  return (
    <Frame className="min-w-0" variant="ghost">
      <FrameHeader>
        <FrameTitle>Recent deployments</FrameTitle>
      </FrameHeader>
      <FramePanel className={rows.length === 0 ? undefined : "p-0"}>
        {rows.length === 0 ? (
          <p className="text-muted-foreground text-sm">No deployments yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Service</TableHead>
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
                      <Badge variant={badgeVariant(status.tone)}>
                        {status.label}
                      </Badge>
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
