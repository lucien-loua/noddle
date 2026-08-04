// La destination des sauvegardes, à côté des serveurs et non dans le
// dashboard.
//
// Même raison que pour les machines : « où partent les sauvegardes » ne répond
// ni à « est-ce que ça tourne ? » ni à « comment je ship ? ». C'est une
// configuration qu'on règle une fois. Le bouton Sauvegarder, lui, reste sur la
// base elle-même, là où on se pose la question.
import { createFileRoute, redirect } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";
import { BackupDestinationPanel } from "@/components/backup-destination-panel";
import { getAuthState } from "@/server/auth";
import { getDestination } from "@/server/backups";

export const Route = createFileRoute("/sauvegardes")({
  beforeLoad: async () => {
    const state = await getAuthState();
    if (!state.signedIn) {
      throw redirect({ to: "/login" });
    }
    return { email: state.email, role: state.role };
  },
  component: BackupsPage,
  loader: async ({ context }) => ({
    destination: await getDestination(),
    email: context.email,
    role: context.role,
  }),
});

function BackupsPage() {
  const { destination, email, role } = Route.useLoaderData();

  return (
    <AppShell email={email} title="Backups">
      <p className="mb-6 max-w-2xl text-muted-foreground text-sm">
        One S3-compatible store for the whole installation. Credentials are
        encrypted at rest and never leave the control plane — Noddle's own
        servers push the dumps, never your target machines.
      </p>
      <BackupDestinationPanel initial={destination} role={role} />
    </AppShell>
  );
}
