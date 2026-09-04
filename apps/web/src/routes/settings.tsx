import { createFileRoute, redirect } from "@tanstack/react-router";

import { AppShell } from "@/components/app-shell";
import { DashboardDomain } from "@/components/features/servers/dashboard-domain";
import { Maintenance } from "@/components/features/settings/maintenance";
import { UpdatePanel } from "@/components/features/updates/panel";
import { roles } from "@/lib/permissions";
import type { RoleName } from "@/lib/permissions";
import { useCan } from "@/lib/use-permission";
import { getAuthState } from "@/server/auth";

export const Route = createFileRoute("/settings")({
  beforeLoad: async () => {
    const state = await getAuthState();
    if (!state.signedIn) {
      throw redirect({ to: "/login" });
    }
    return { email: state.email, role: state.role };
  },
  component: SettingsPage,
  loader: ({ context }) => ({ email: context.email, role: context.role }),
});

function SettingsPage() {
  const { email, role } = Route.useLoaderData();
  const known = role && role in roles ? (role as RoleName) : null;
  const canAdmin = useCan(known, "server", "create");

  return (
    <AppShell email={email} role={role} title="Settings">
      <div className="flex flex-col gap-4">
        <DashboardDomain canEdit={canAdmin} />
        <Maintenance canRun={canAdmin} />
        <UpdatePanel role={known} />
      </div>
    </AppShell>
  );
}
