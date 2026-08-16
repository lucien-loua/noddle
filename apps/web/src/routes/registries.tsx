import { PlusIcon } from "@phosphor-icons/react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { AppShell } from "@/components/app-shell";
import {
  RegistriesList,
  RegistryDialog,
} from "@/components/features/registries/registries-panel";
import { Button } from "@/components/ui/button";
import { type RoleName, roles } from "@/lib/permissions";
import { useCan } from "@/lib/use-permission";
import { getAuthState } from "@/server/auth";
import { getRegistries, type RegistryView } from "@/server/registries";

export const Route = createFileRoute("/registries")({
  beforeLoad: async () => {
    const state = await getAuthState();
    if (!state.signedIn) {
      throw redirect({ to: "/login" });
    }
    return { email: state.email, role: state.role };
  },
  component: RegistriesPage,
  // `getRegistries` requires `registry: read`, which neither `viewer` nor
  // `deployer` have: without this a loader exception would render a bare
  // error page.
  errorComponent: () => (
    <p className="p-6 text-muted-foreground text-sm">
      Your role does not allow reading registries.
    </p>
  ),
  loader: async ({ context }) => ({
    email: context.email,
    registries: await getRegistries(),
    role: context.role,
  }),
});

function RegistriesPage() {
  const { email, registries, role } = Route.useLoaderData();
  const known: RoleName | null =
    role && role in roles ? (role as RoleName) : null;
  const canAdd = useCan(known, "registry", "create");

  // "Open" and "on what" are only ONE state: separating them had let the
  // add button reopen the PREFILLED dialog and overwrite the row that had
  // just been edited, a flaw already paid for on S3 destinations.
  const [target, setTarget] = useState<RegistryView | null>(null);
  const [open, setOpen] = useState(false);

  const handleAdd = useCallback(() => {
    setTarget(null);
    setOpen(true);
  }, []);
  const handleEdit = useCallback((row: RegistryView) => {
    setTarget(row);
    setOpen(true);
  }, []);

  return (
    <AppShell
      actions={
        canAdd ? (
          <Button onClick={handleAdd}>
            <PlusIcon data-icon="inline-start" weight="regular" />
            Add registry
          </Button>
        ) : null
      }
      email={email}
      role={role}
      title="Registries"
    >
      {canAdd ? (
        <RegistryDialog onOpenChange={setOpen} open={open} target={target} />
      ) : null}
      <RegistriesList
        initial={registries}
        onAdd={canAdd ? handleAdd : undefined}
        onEdit={handleEdit}
        role={known}
      />
    </AppShell>
  );
}
