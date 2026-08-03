// Les machines, séparées des applications.
//
// Un serveur ne répond ni à « est-ce que ça tourne ? » ni à « comment je
// déploie ? » — les deux questions que le dashboard doit trancher sans
// détour. Le sortir de cet écran-là, c'est lui rendre sa densité.
import { PlusIcon } from "@phosphor-icons/react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { AddServerDialog, ServersList } from "@/components/servers-panel";
import { Button } from "@/components/ui/button";
import { getAuthState } from "@/server/auth";
import { getServers } from "@/server/servers";

export const Route = createFileRoute("/serveurs")({
  beforeLoad: async () => {
    const state = await getAuthState();
    if (!state.signedIn) {
      throw redirect({ to: "/login" });
    }
    return { email: state.email };
  },
  component: ServersPage,
  loader: async ({ context }) => ({
    email: context.email,
    servers: await getServers(),
  }),
});

function ServersPage() {
  const { email, servers } = Route.useLoaderData();
  const [open, setOpen] = useState(false);
  const handleOpen = useCallback(() => setOpen(true), []);

  return (
    <AppShell
      actions={
        <Button onClick={handleOpen} size="sm">
          <PlusIcon data-icon="inline-start" />
          Ajouter un serveur
        </Button>
      }
      email={email}
      title="Serveurs"
    >
      <AddServerDialog onOpenChange={setOpen} open={open} />
      <ServersList initial={servers} />
    </AppShell>
  );
}
