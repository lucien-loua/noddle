// Les comptes, à côté des serveurs, des sauvegardes et des notifications.
//
// Même raison qu'eux : « qui a accès » ne répond ni à « est-ce que ça
// tourne ? » ni à « comment je ship ? ». C'est une configuration qu'on règle
// rarement, donc elle ne prend pas de place dans le dashboard.
import { createFileRoute, redirect } from "@tanstack/react-router";
import { AccountsPanel } from "@/components/accounts-panel";
import { AppShell } from "@/components/app-shell";
import { getAccounts } from "@/server/accounts";
import { getAuthState } from "@/server/auth";

export const Route = createFileRoute("/comptes")({
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

  return (
    <AppShell email={email} title="Comptes">
      <AccountsPanel initial={accounts} role={role} />
    </AppShell>
  );
}
