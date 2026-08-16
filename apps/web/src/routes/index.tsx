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
import { cn } from "@/lib/utils";
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
  // No services / stacks / databases yet. The dashboard still renders: a
  // full-page empty would hide the layout the user is about to live in.
  const nothingAtAll = Object.keys(statusCounts).length === 0;

  return (
    <AppShell
      actions={
        <Button nativeButton={false} render={<Link to="/projects" />}>
          Go to projects
          <ArrowRightIcon data-icon="inline-end" weight="regular" />
        </Button>
      }
      email={email}
      role={role}
      title="Overview"
    >
      <div
        className={cn(
          "flex min-w-0 flex-col gap-6",
          // `h-full`: AppShell's scroller is not a flex column, so `flex-1`
          // here would not stretch. Same as the environment grid empty.
          activity.length === 0 && "h-full"
        )}
      >
        <StatCards counts={overview.counts} statusCounts={statusCounts} />
        <AttentionPanel idle={nothingAtAll} rows={attention} />
        <ActivityPanel rows={activity} />
      </div>
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
  const hasStatus = Object.values(statusCounts).some((n) => n > 0);

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatCard icon={FolderIcon} label="Projects">
        <StatNumber
          detail={`${counts.environments} environment${counts.environments === 1 ? "" : "s"}`}
          value={counts.projects}
        />
      </StatCard>
      <StatCard icon={CubeIcon} label="Services">
        <StatNumber
          detail={`${counts.services} app${counts.services === 1 ? "" : "s"} · ${counts.stacks} compose · ${counts.databases} db`}
          value={counts.services + counts.stacks + counts.databases}
        />
      </StatCard>
      <StatCard icon={RocketLaunchIcon} label="Deploys">
        <StatNumber
          detail={counts.deploys7d === 0 ? "no activity yet" : "last 7 days"}
          value={counts.deploys7d}
        />
      </StatCard>
      <StatCard icon={PulseIcon} label="Status">
        {hasStatus ? (
          <StatusSummary counts={statusCounts} />
        ) : (
          <p className="text-muted-foreground text-sm">no services yet</p>
        )}
      </StatCard>
    </div>
  );
}

/**
 * The shell: the measure's name is chrome, its value is the panel.
 *
 * The status tile used to repeat this markup by hand because it holds a
 * breakdown instead of a number — it now takes the same shell and only
 * differs by what it puts inside it.
 */
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
      {/* `text-muted-foreground` sits on the header, not on the title: the
          glyph takes its colour from the row it belongs to, so there is one
          place to change and no second copy to keep in step. */}
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

/**
 * What isn't running.
 *
 * When the list is empty, we SAY so instead of hiding the section: "nothing
 * to report" is information, and a section that disappears leaves doubt
 * about what it would have shown. An install with no services is not
 * healthy — it is idle — so that case does not borrow the green check.
 */
function AttentionPanel({
  idle,
  rows,
}: {
  idle: boolean;
  rows: Overview["attention"];
}) {
  return (
    <section className="min-w-0">
      <h2 className="mb-2 px-1 font-semibold text-foreground text-sm">
        Needs attention
      </h2>

      {rows.length === 0 ? (
        <Frame variant="ghost">
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
        </Frame>
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
  const empty = rows.length === 0;

  return (
    <Frame
      className={empty ? "min-h-0 min-w-0 flex-1" : "min-w-0"}
      variant="ghost"
    >
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
      <FramePanel className={empty ? "flex min-h-0 flex-1 flex-col" : "p-0"}>
        {empty ? (
          <Empty className="min-h-48 flex-1 border-0">
            <EmptyTitle>Nothing deployed yet</EmptyTitle>
            <EmptyDescription>
              Connect a repository, a Compose stack or a database to get
              started.
            </EmptyDescription>
            <EmptyContent>
              <Button nativeButton={false} render={<Link to="/projects" />}>
                Get started
              </Button>
            </EmptyContent>
          </Empty>
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
