import { BellIcon } from "@phosphor-icons/react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useCallback, useState } from "react";

import { AppShell } from "@/components/app-shell";
import { NotificationChannels } from "@/components/features/notifications/notification-channels";
import { useResourceList } from "@/components/features/settings-list/hooks/use-resource-list";
import { Button } from "@/components/ui/button";
import { roles } from "@/lib/permissions";
import type { RoleName } from "@/lib/permissions";
import { queries } from "@/lib/queries";
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
  const known: RoleName | null =
    role && role in roles ? (role as RoleName) : null;
  const canManage = useCan(known, "notification", "manage");
  const { isEmpty } = useResourceList(queries.channels, channels);

  const [open, setOpen] = useState(false);
  const handleOpen = useCallback(() => setOpen(true), []);

  return (
    <AppShell
      actions={
        canManage && !isEmpty ? (
          <Button onClick={handleOpen}>
            <BellIcon data-icon="inline-start" weight="regular" />
            Add channel
          </Button>
        ) : null
      }
      email={email}
      role={role}
      title="Notifications"
    >
      <NotificationChannels
        initial={channels}
        onOpenChange={setOpen}
        open={open}
        role={role}
      />
    </AppShell>
  );
}
