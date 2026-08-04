// Les canaux de notification, à côté des serveurs et des sauvegardes.
//
// Même raison que pour eux : « où Noddle prévient » ne répond ni à « est-ce
// que ça tourne ? » ni à « comment je ship ? ». C'est une configuration qu'on
// règle une fois, donc elle ne prend pas de place dans le dashboard.
import { createFileRoute, redirect } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";
import { NotificationChannels } from "@/components/notification-channels";
import { getAuthState } from "@/server/auth";
import { getChannels } from "@/server/notifications";

export const Route = createFileRoute("/notifications")({
  beforeLoad: async () => {
    const state = await getAuthState();
    if (!state.signedIn) {
      throw redirect({ to: "/login" });
    }
    return { email: state.email };
  },
  component: NotificationsPage,
  loader: async ({ context }) => ({
    channels: await getChannels(),
    email: context.email,
  }),
});

function NotificationsPage() {
  const { channels, email } = Route.useLoaderData();

  return (
    <AppShell email={email} title="Notifications">
      <NotificationChannels initial={channels} />
    </AppShell>
  );
}
