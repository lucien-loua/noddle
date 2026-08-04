// Les machines, séparées des applications.
//
// Un serveur ne répond ni à « est-ce que ça tourne ? » ni à « comment je
// déploie ? » — les deux questions que le dashboard doit trancher sans
// détour. Le sortir de cet écran-là, c'est lui rendre sa densité.
import { PlusIcon } from "@phosphor-icons/react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { ResourceGraphs } from "@/components/resource-graphs";
import { AddServerDialog, ServersList } from "@/components/servers-panel";
import { Button } from "@/components/ui/button";
import { type RoleName, roles } from "@/lib/permissions";
import { useCan } from "@/lib/use-permission";
import { getAuthState } from "@/server/auth";
import { getServerMetrics } from "@/server/metrics";
import { getServers } from "@/server/servers";

export const Route = createFileRoute("/servers")({
  beforeLoad: async () => {
    const state = await getAuthState();
    if (!state.signedIn) {
      throw redirect({ to: "/login" });
    }
    return { email: state.email, role: state.role };
  },
  component: ServersPage,
  loader: async ({ context }) => ({
    email: context.email,
    metrics: await getServerMetrics(),
    role: context.role,
    servers: await getServers(),
  }),
});

function ServersPage() {
  const { email, metrics, role, servers } = Route.useLoaderData();
  const known = role && role in roles ? (role as RoleName) : null;
  const canAdd = useCan(known, "server", "create");
  const [open, setOpen] = useState(false);
  const handleOpen = useCallback(() => setOpen(true), []);

  return (
    <AppShell
      actions={
        canAdd ? (
          <Button onClick={handleOpen} size="sm">
            <PlusIcon data-icon="inline-start" />
            Add server
          </Button>
        ) : null
      }
      email={email}
      title="Servers"
    >
      {canAdd ? <AddServerDialog onOpenChange={setOpen} open={open} /> : null}
      <ServersList initial={servers} />

      {/* Sous la liste : « quelles machines ai-je » vient avant « comment
          vont-elles ». */}
      <section className="mt-8">
        <h2 className="mb-3 font-medium text-sm">Resources</h2>
        <ResourceGraphs series={metrics} />
      </section>
    </AppShell>
  );
}
