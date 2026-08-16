import { PlusIcon } from "@phosphor-icons/react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { AppShell } from "@/components/app-shell";
import {
  AddSshKeyDialog,
  SshKeysList,
} from "@/components/features/ssh-keys/ssh-keys-panel";
import { Button } from "@/components/ui/button";
import { type RoleName, roles } from "@/lib/permissions";
import { useCan } from "@/lib/use-permission";
import { getAuthState } from "@/server/auth";
import { getSshKeys } from "@/server/ssh-keys";

export const Route = createFileRoute("/ssh-keys")({
  beforeLoad: async () => {
    const state = await getAuthState();
    if (!state.signedIn) {
      throw redirect({ to: "/login" });
    }
    return { email: state.email, role: state.role };
  },
  component: SshKeysPage,
  // `getSshKeys` requires `sshKey: read`, which neither `viewer` nor
  // `deployer` have: an unhandled loader exception renders a bare error
  // page. Same fix as /audit, and for the same reason — we do NOT move the
  // decision into `beforeLoad`, or the guard wouldn't run and the attempt
  // wouldn't be recorded in the audit log.
  errorComponent: () => (
    <p className="p-6 text-muted-foreground text-sm">
      Your role does not allow reading SSH keys.
    </p>
  ),
  loader: async ({ context }) => ({
    email: context.email,
    keys: await getSshKeys(),
    role: context.role,
  }),
});

function SshKeysPage() {
  const { email, keys, role } = Route.useLoaderData();
  const known: RoleName | null =
    role && role in roles ? (role as RoleName) : null;
  const canAdd = useCan(known, "sshKey", "create");
  const [open, setOpen] = useState(false);
  const handleOpen = useCallback(() => setOpen(true), []);

  return (
    <AppShell
      actions={
        canAdd ? (
          <Button onClick={handleOpen}>
            <PlusIcon data-icon="inline-start" weight="regular" />
            Add key
          </Button>
        ) : null
      }
      email={email}
      role={role}
      title="SSH keys"
    >
      {canAdd ? <AddSshKeyDialog onOpenChange={setOpen} open={open} /> : null}
      <SshKeysList
        initial={keys}
        onAdd={canAdd ? handleOpen : undefined}
        role={known}
      />
    </AppShell>
  );
}
