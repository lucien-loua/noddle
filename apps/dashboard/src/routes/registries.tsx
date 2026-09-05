import { PackageIcon } from "@phosphor-icons/react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useCallback, useState } from "react";

import { AppShell } from "@/components/app-shell";
import {
  RegistriesList,
  RegistryDialog,
} from "@/components/features/registries/registries-panel";
import { useResourceList } from "@/components/features/settings-list/hooks/use-resource-list";
import { Button } from "@/components/ui/button";
import { roles } from "@/lib/permissions";
import type { RoleName } from "@/lib/permissions";
import { queries } from "@/lib/queries";
import { useCan } from "@/lib/use-permission";
import { getAuthState } from "@/server/auth";
import { getRegistries } from "@/server/registries";
import type { RegistryView } from "@/server/registries";

export const Route = createFileRoute("/registries")({
  beforeLoad: async () => {
    const state = await getAuthState();
    if (!state.signedIn) {
      throw redirect({ to: "/login" });
    }
    return { email: state.email, role: state.role };
  },
  component: RegistriesPage,
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
  const { isEmpty } = useResourceList(queries.registries, registries);

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
        canAdd && !isEmpty ? (
          <Button onClick={handleAdd}>
            <PackageIcon data-icon="inline-start" weight="regular" />
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
