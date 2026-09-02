import { UsersIcon } from "@phosphor-icons/react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useCallback, useState } from "react";

import { AppShell } from "@/components/app-shell";
import { AccountsPanel } from "@/components/features/accounts/accounts-panel";
import { Button } from "@/components/ui/button";
import { roles } from "@/lib/permissions";
import type { RoleName } from "@/lib/permissions";
import { useCan } from "@/lib/use-permission";
import { getAccounts } from "@/server/accounts";
import { getAuthState } from "@/server/auth";

export const Route = createFileRoute("/accounts")({
  beforeLoad: async () => {
    const state = await getAuthState();
    if (!state.signedIn) {
      throw redirect({ to: "/login" });
    }
    return { email: state.email, role: state.role };
  },
  component: AccountsPage,
  loader: async ({ context }) => ({
    accounts: await getAccounts(),
    email: context.email,
    role: context.role,
  }),
});

function AccountsPage() {
  const { accounts, email, role } = Route.useLoaderData();
  const known: RoleName | null =
    role && role in roles ? (role as RoleName) : null;
  const canCreate = useCan(known, "user", "create");

  const [open, setOpen] = useState(false);
  const handleOpen = useCallback(() => setOpen(true), []);

  return (
    <AppShell
      actions={
        canCreate ? (
          <Button onClick={handleOpen}>
            <UsersIcon data-icon="inline-start" weight="regular" />
            New account
          </Button>
        ) : null
      }
      email={email}
      role={role}
      title="Accounts"
    >
      <AccountsPanel
        initial={accounts}
        onOpenChange={setOpen}
        open={open}
        role={role}
      />
    </AppShell>
  );
}
