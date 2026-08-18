import { TerminalIcon } from "@phosphor-icons/react";
import { createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { useCallback, useState } from "react";

import { AppShell } from "@/components/app-shell";
import { DetailBreadcrumb } from "@/components/detail-breadcrumb";
import { UpdatePanel } from "@/components/features/updates/panel";
import { ResourceGraphs } from "@/components/resource-graphs";
import { ServerDiskUsage } from "@/components/server-disk";
import { ServerPruneToggle } from "@/components/server-prune-toggle";
import { ServerToolchain } from "@/components/server-toolchain";
import { useTerminalDialog } from "@/components/terminal-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Frame,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@/components/ui/frame";
import { roles } from "@/lib/permissions";
import type { RoleName } from "@/lib/permissions";
import { useCan } from "@/lib/use-permission";
import { getAuthState } from "@/server/auth";
import { getServerDiskUsage, getServerMetrics } from "@/server/metrics";
import { getServers } from "@/server/servers";
import type { ServerView } from "@/server/servers";

const STATUS_LABEL: Record<ServerView["status"], string> = {
  connected: "Connected",
  pending: "Provisioning…",
  unreachable: "Unreachable",
};

// The trailing `_` in the filename isn't decorative: without it, flat
// routing makes `servers.tsx` the LAYOUT for this route, and since that
// screen has no `Outlet`, the detail view would never render — we'd fall
// back to the list, with no error at either typecheck or runtime.
// `services`/`stacks`/`databases` didn't have this trap: none of them has a
// parent file of the same name. The URL itself does stay `/servers/<id>`.
export const Route = createFileRoute("/servers_/$serverId")({
  beforeLoad: async () => {
    const state = await getAuthState();
    if (!state.signedIn) {
      throw redirect({ to: "/login" });
    }
    return { email: state.email, role: state.role };
  },
  component: ServerDetail,
  loader: async ({ context, params }) => {
    const [machines, metrics, disks] = await Promise.all([
      getServers(),
      getServerMetrics(),
      getServerDiskUsage(),
    ]);
    const server = machines.find((s) => s.id === params.serverId);
    if (!server) {
      throw notFound();
    }
    return {
      disk: disks.find((d) => d.serverId === server.id) ?? null,
      email: context.email,
      role: context.role,
      // THIS machine, not the list: that's what allowed removing the flat
      // list of cards from /servers, and `ResourceGraphs` now only renders
      // one machine. `null` if the read knows nothing about it — never an
      // empty card that could be mistaken for an idle machine.
      series: metrics.find((m) => m.serverId === server.id) ?? null,
      server,
    };
  },
});

/** A labeled fact, same shape as on a service's detail page. */
function Fact({
  children,
  label,
}: {
  children: React.ReactNode;
  label: string;
}) {
  return (
    <div className="min-w-0">
      <dt className="mb-0.5 text-muted-foreground text-xs">{label}</dt>
      <dd className="truncate text-sm">{children}</dd>
    </div>
  );
}

function ServerDetail() {
  const { disk, email, role, series, server } = Route.useLoaderData();
  // Same narrowing as on other routes: the role comes from the session as a
  // `string`, and `useCan` expects a KNOWN role. An unknown role is treated
  // as `null` — so no action is offered — rather than an optimistic cast.
  const known = role && role in roles ? (role as RoleName) : null;
  const canShell = useCan(known, "server", "shell");
  const { openTerminal, terminal } = useTerminalDialog();
  const [pruneError, setPruneError] = useState<string | null>(null);
  const [usageOpen, setUsageOpen] = useState(true);
  const handlePruneError = useCallback((m: string) => setPruneError(m), []);
  const handleOpenTerminal = useCallback(() => {
    openTerminal({
      kind: "ssh",
      serverId: server.id,
      title: server.name,
    });
  }, [openTerminal, server.id, server.name]);

  return (
    <AppShell
      actions={
        <div className="flex items-center gap-2">
          {canShell ? (
            <Button onClick={handleOpenTerminal} size="sm" variant="outline">
              <TerminalIcon weight="regular" />
              Terminal
            </Button>
          ) : null}
          <Badge variant="outline">{STATUS_LABEL[server.status]}</Badge>
        </div>
      }
      breadcrumb={
        <DetailBreadcrumb
          name={server.name}
          parent={{ label: "Servers", to: "/servers" }}
        />
      }
      email={email}
      role={role}
      title={server.name}
    >
      {/* Two groups, and the headings name the GROUP rather than
          repeating the frame under them: every section used to be a
          synonym of the title 4px below it — "Overview / Machine details",
          "Resources / Live resources". What this machine IS goes together
          (its facts, and the tools it can run); what it is DOING goes
          together (load, memory, disk). */}
      <section className="space-y-3">
        <h2 className="font-medium text-sm">Machine</h2>
        <Frame variant="ghost">
          <FrameHeader>
            <FrameTitle>Machine details</FrameTitle>
          </FrameHeader>
          <FramePanel>
            {/* No Docker version here: `Installed tools` below reads it
                LIVE off the machine and flags drift, where this column was
                whatever provisioning last wrote down. Two values for one
                fact, and the stale one on top. */}
            <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
              <Fact label="Host">
                <span className="font-mono">{server.host}</span>
              </Fact>
              <Fact label="Role">
                {server.role === "manager" ? "Swarm manager" : "Swarm worker"}
              </Fact>
              <Fact label="Memory">
                {server.totalMemoryMb ? (
                  `${Math.round(server.totalMemoryMb / 1024)} GB`
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </Fact>
            </dl>

            {/* The access error lives here and not just on the list row:
                this is the page you come to in order to find out why the
                machine isn't responding. */}
            {server.status === "unreachable" && server.lastError ? (
              <output className="block mt-4 text-destructive text-sm">
                {server.lastError}
              </output>
            ) : null}
          </FramePanel>
        </Frame>

        {/* Kept next to the machine's facts and BEFORE usage: a machine
            that cannot build is not a performance question, and it is what
            makes a deploy fail. */}
        <ServerToolchain
          reachable={server.status !== "unreachable"}
          role={known}
          serverId={server.id}
        />
      </section>

      {/* WHAT IT IS DOING — the live half, and the tall half, so this is
          the group that folds. Folded at the SECTION level: `ResourceGraphs`
          and `ServerDiskUsage` are `stacked` frames whose joined panels are
          styled by direct-child adjacency, and a wrapper inside either one
          would break the join. Open by default — a section that hides
          itself makes you wonder what you are missing.

          Disk belongs here and nowhere else: it is PER NODE and does not
          aggregate across machines. It also makes a mechanism we already
          have visible — registry retention was reclaiming 359MB out of 364
          without anything showing it on screen. */}
      <section className="mt-8 space-y-3">
        <Collapsible onOpenChange={setUsageOpen} open={usageOpen}>
          <div className="flex items-center justify-between gap-3">
            <h2 className="font-medium text-sm">Usage</h2>
            <CollapsibleTrigger
              render={
                <Button size="sm" variant="ghost">
                  {usageOpen ? "Hide" : "Show"}
                </Button>
              }
            />
          </div>
          <CollapsibleContent className="mt-3 space-y-3">
            <ResourceGraphs series={series} />
            <ServerDiskUsage disk={disk}>
              {/* Keyed on the server's own value: the toggle holds an
                  optimistic copy, and without this a refetch that changes
                  pruneEnabled would leave the switch showing the old one. */}
              <ServerPruneToggle
                enabled={server.pruneEnabled}
                key={`prune-${server.id}-${server.pruneEnabled}`}
                error={pruneError}
                onError={handlePruneError}
                role={known}
                serverId={server.id}
              />
            </ServerDiskUsage>
          </CollapsibleContent>
        </Collapsible>
      </section>

      {/* On the MANAGER only, and this isn't a display detail: `install.sh`
          runs on the machine hosting the control plane, which is this one.
          The installer adopts its own machine as the manager and only adds
          workers afterwards, so `role` does point to the right row — and
          it's the field the code is allowed to branch on, unlike `isSelf`
          which stays display-only. */}
      {server.role === "manager" ? (
        <section className="mt-8">
          {/* No heading: the panel titles itself "Noddle", and it is the
              one block on this page that is not about the machine. */}
          <UpdatePanel role={known} />
        </section>
      ) : null}
      {terminal}
    </AppShell>
  );
}
