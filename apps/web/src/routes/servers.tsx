import { PlusIcon } from "@phosphor-icons/react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useCallback, useState } from "react";

import { AppShell } from "@/components/app-shell";
import { AddServerDialog, ServersList } from "@/components/features/servers/servers-panel";
import { Button } from "@/components/ui/button";
import { roles } from "@/lib/permissions";
import type { RoleName } from "@/lib/permissions";
import { useCan } from "@/lib/use-permission";
import { getAuthState } from "@/server/auth";
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
    role: context.role,
    servers: await getServers(),
  }),
});

function ServersPage() {
  const { email, role, servers } = Route.useLoaderData();
  const known = role && role in roles ? (role as RoleName) : null;
  const canAdd = useCan(known, "server", "create");
  const [open, setOpen] = useState(false);
  const handleOpen = useCallback(() => setOpen(true), []);

  return (
    <AppShell
      actions={
        canAdd ? (
          <Button onClick={handleOpen}>
            <PlusIcon data-icon="inline-start" weight="regular" />
            Add server
          </Button>
        ) : null
      }
      email={email}
      role={role}
      title="Servers"
    >
      {canAdd ? <AddServerDialog onOpenChange={setOpen} open={open} /> : null}
      <ServersList initial={servers} onAdd={canAdd ? handleOpen : undefined} role={known} />
    </AppShell>
  );
}
