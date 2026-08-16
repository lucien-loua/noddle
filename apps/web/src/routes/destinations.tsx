import { createFileRoute, redirect } from "@tanstack/react-router";
import { useCallback, useState } from "react";

import { AppShell } from "@/components/app-shell";
import { S3DestinationPanel } from "@/components/features/destinations/s3-destination-panel";
import { useResourceList } from "@/components/features/settings-list/hooks/use-resource-list";
import { Button } from "@/components/ui/button";
import { roles } from '@/lib/permissions';
import type { RoleName } from '@/lib/permissions';
import { queries } from "@/lib/queries";
import { useCan } from "@/lib/use-permission";
import { getAuthState } from "@/server/auth";
import { getDestinations } from '@/server/backups/destinations';
import type { DestinationRow } from '@/server/backups/destinations';

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
  const { destinations: initial, email, role } = Route.useLoaderData();
  const known: RoleName | null =
    role && role in roles ? (role as RoleName) : null;
  const canEdit = useCan(known, "backup", "create");
  const { data: destinations, isEmpty } = useResourceList(
    queries.destinations,
    initial
  );

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<DestinationRow | null>(null);

  const handleOpen = useCallback(() => {
    setEditing(null);
    setOpen(true);
  }, []);

  return (
    <AppShell
      actions={
        canEdit && !isEmpty ? (
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
