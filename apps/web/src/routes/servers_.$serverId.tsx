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
import { type RoleName, roles } from "@/lib/permissions";
import { useCan } from "@/lib/use-permission";
import { getAuthState } from "@/server/auth";
import { getServerDiskUsage, getServerMetrics } from "@/server/metrics";
import { getServers, type ServerView } from "@/server/servers";

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
  const [resourcesOpen, setResourcesOpen] = useState(true);
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
              <TerminalIcon weight="bold" />
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
      <section className="space-y-3">
        <h2 className="font-medium text-sm">Overview</h2>
        <Frame variant="ghost">
          <FrameHeader>
            <FrameTitle>Machine details</FrameTitle>
          </FrameHeader>
          <FramePanel>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
              <Fact label="Host">
                <span className="font-mono">{server.host}</span>
              </Fact>
              <Fact label="Role">
                {server.role === "manager" ? "Swarm manager" : "Swarm worker"}
              </Fact>
              <Fact label="Docker">
                {server.dockerVersion ?? (
                  <span className="text-muted-foreground">—</span>
                )}
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
              <p className="mt-4 text-destructive text-sm" role="status">
                {server.lastError}
              </p>
            ) : null}
          </FramePanel>
        </Frame>
      </section>

      {/* Before Resources on purpose: a machine that cannot build is not a
          performance question, and it is what makes a deploy fail. */}
      <section className="mt-8 space-y-3">
        <h2 className="font-medium text-sm">Toolchain</h2>
        <ServerToolchain
          reachable={server.status !== "unreachable"}
          role={known}
          serverId={server.id}
        />
      </section>

      {/* The one section worth folding on this page: four stacked
          sparklines are the tallest thing here, and they sit between the
          toolchain and the disk. Folded at the SECTION level rather than
          inside the frame — `ResourceGraphs` is a `stacked` frame, whose
          joined panels are styled by direct-child adjacency, and a
          wrapper inside it would break that. Open by default: a section
          that hides itself makes you wonder what you are missing. */}
      <section className="mt-8 space-y-3">
        <Collapsible onOpenChange={setResourcesOpen} open={resourcesOpen}>
          <div className="flex items-center justify-between gap-3">
            <h2 className="font-medium text-sm">Resources</h2>
            <CollapsibleTrigger
              render={
                <Button size="sm" variant="ghost">
                  {resourcesOpen ? "Hide" : "Show"}
                </Button>
              }
            />
          </div>
          <CollapsibleContent className="mt-3">
            <ResourceGraphs series={series} />
          </CollapsibleContent>
        </Collapsible>
      </section>

      {/* Disk is PER NODE and doesn't aggregate across machines: that's why
          it belongs here and nowhere else. It also makes a mechanism we
          already have visible — registry retention was reclaiming 359MB out
          of 364 without anything showing it on screen. */}
      <section className="mt-8 space-y-3">
        <h2 className="font-medium text-sm">Disk</h2>
        <ServerDiskUsage disk={disk}>
          <ServerPruneToggle
            enabled={server.pruneEnabled}
            error={pruneError}
            onError={handlePruneError}
            role={known}
            serverId={server.id}
          />
        </ServerDiskUsage>
      </section>

      {/* On the MANAGER only, and this isn't a display detail: `install.sh`
          runs on the machine hosting the control plane, which is this one.
          The installer adopts its own machine as the manager and only adds
          workers afterwards, so `role` does point to the right row — and
          it's the field the code is allowed to branch on, unlike `isSelf`
          which stays display-only. */}
      {server.role === "manager" ? (
        <section className="mt-8 space-y-3">
          <h2 className="font-medium text-sm">Version</h2>
          <UpdatePanel role={known} />
        </section>
      ) : null}
      {terminal}
    </AppShell>
  );
}
