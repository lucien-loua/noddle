import { createFileRoute, redirect } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { S3DestinationPanel } from "@/components/s3-destination-panel";
import { Button } from "@/components/ui/button";
import { type RoleName, roles } from "@/lib/permissions";
import { useCan } from "@/lib/use-permission";
import { getAuthState } from "@/server/auth";
import { type DestinationRow, getDestinations } from "@/server/backups";

export const Route = createFileRoute("/destinations")({
  beforeLoad: async () => {
    const state = await getAuthState();
    if (!state.signedIn) {
      throw redirect({ to: "/login" });
    }
    return { email: state.email, role: state.role };
  },
  component: DestinationsPage,
  loader: async ({ context }) => ({
    destinations: await getDestinations(),
    email: context.email,
    role: context.role,
  }),
});

function DestinationsPage() {
  const { destinations, email, role } = Route.useLoaderData();
  const known: RoleName | null =
    role && role in roles ? (role as RoleName) : null;
  const canEdit = useCan(known, "backup", "create");

  // "Open" and "on what" live TOGETHER here: they're two faces of the same
  // state. Separating them let the "Add destination" button open the
  // dialog on the previously-edited destination — and so overwrite it.
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<DestinationRow | null>(null);

  const handleOpen = useCallback(() => {
    setEditing(null);
    setOpen(true);
  }, []);

  return (
    <AppShell
      actions={
        // Hidden when there are none: the empty state already carries its
        // own button, and two calls to action for the same gesture would
        // compete with each other.
        canEdit && destinations.length > 0 ? (
          <Button onClick={handleOpen}>Add destination</Button>
        ) : null
      }
      email={email}
      role={role}
      title="S3 destinations"
    >
      <S3DestinationPanel
        destinations={destinations}
        editing={editing}
        onEdit={setEditing}
        onOpenChange={setOpen}
        open={open}
        role={role}
      />
    </AppShell>
  );
}
