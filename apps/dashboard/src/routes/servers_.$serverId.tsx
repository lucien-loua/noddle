import { TerminalIcon } from "@phosphor-icons/react";
import { createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { useCallback, useState } from "react";

import { AppShell } from "@/components/app-shell";
import { DetailBreadcrumb } from "@/components/detail-breadcrumb";
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
      series: metrics.find((m) => m.serverId === server.id) ?? null,
      server,
    };
  },
});

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
              Open terminal
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
        <h2 className="font-medium text-sm">Machine</h2>
        <Frame variant="ghost">
          <FrameHeader>
            <FrameTitle>Machine details</FrameTitle>
          </FrameHeader>
          <FramePanel>
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

            {server.status === "unreachable" && server.lastError ? (
              <output className="block mt-4 text-destructive text-sm">
                {server.lastError}
              </output>
            ) : null}
          </FramePanel>
        </Frame>

        <ServerToolchain
          reachable={server.status !== "unreachable"}
          role={known}
          serverId={server.id}
        />
      </section>

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

      {terminal}
    </AppShell>
  );
}
