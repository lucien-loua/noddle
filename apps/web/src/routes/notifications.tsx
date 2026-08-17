import { createFileRoute, redirect } from "@tanstack/react-router";
import { useCallback, useState } from "react";

import { AppShell } from "@/components/app-shell";
import { NotificationChannels } from "@/components/features/notifications/notification-channels";
import { Button } from "@/components/ui/button";
import { roles } from "@/lib/permissions";
import type { RoleName } from "@/lib/permissions";
import { useCan } from "@/lib/use-permission";
import { getAuthState } from "@/server/auth";
import { getChannels } from "@/server/notifications";

export const Route = createFileRoute("/notifications")({
  beforeLoad: async () => {
    const state = await getAuthState();
    if (!state.signedIn) {
      throw redirect({ to: "/login" });
    }
    return { email: state.email, role: state.role };
  },
  component: NotificationsPage,
  loader: async ({ context }) => ({
    channels: await getChannels(),
    email: context.email,
    role: context.role,
  }),
});

function NotificationsPage() {
  const { channels, email, role } = Route.useLoaderData();
  const known: RoleName | null = role && role in roles ? (role as RoleName) : null;
  const canManage = useCan(known, "notification", "manage");

  // The dialog's state lives HERE and not in the panel: its opening button
  // is mounted in AppShell's header, not in the page body. Same shape as the
  // dashboard, where "New" is already an `actions`.
  const [open, setOpen] = useState(false);
  const handleOpen = useCallback(() => setOpen(true), []);

  return (
    <AppShell
      actions={canManage ? <Button onClick={handleOpen}>Add channel</Button> : null}
      email={email}
      role={role}
      title="Notifications"
    >
      <NotificationChannels initial={channels} onOpenChange={setOpen} open={open} role={role} />
    </AppShell>
  );
}
