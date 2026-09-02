import { CaretDownIcon, StackIcon } from "@phosphor-icons/react";
import { useCallback, useState } from "react";

import { ConnectDatabaseDialog } from "@/components/features/database/connect-database-dialog";
import { ConnectRepoDialog } from "@/components/features/services/connect-repo-dialog";
import { ConnectStackDialog } from "@/components/features/stacks/connect-stack-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { RoleName } from "@/lib/permissions";
import { useCan } from "@/lib/use-permission";
import type { ServerView } from "@/server/servers";

type Kind = "database" | "repo" | "stack";

export function CreateServiceMenu({
  align = "end",
  environmentName,
  projectName,
  role,
  servers,
}: {
  align?: "center" | "end";
  environmentName?: string;
  projectName?: string;
  role: RoleName | null;
  servers: ServerView[];
}) {
  const [dialog, setDialog] = useState<Kind | null>(null);
  const canCreateService = useCan(role, "service", "create");
  const canCreateDatabase = useCan(role, "database", "create");

  const closeDialog = useCallback((open: boolean) => {
    if (!open) {
      setDialog(null);
    }
  }, []);
  const openRepo = useCallback(() => setDialog("repo"), []);
  const openStack = useCallback(() => setDialog("stack"), []);
  const openDatabase = useCallback(() => setDialog("database"), []);

  if (!(canCreateService || canCreateDatabase)) {
    return null;
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button />}>
          <StackIcon data-icon="inline-start" weight="regular" />
          Create resource
          <CaretDownIcon data-icon="inline-end" weight="regular" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align={align}>
          {canCreateService ? (
            <DropdownMenuItem onClick={openRepo}>Application</DropdownMenuItem>
          ) : null}
          {canCreateDatabase ? (
            <DropdownMenuItem onClick={openDatabase}>Database</DropdownMenuItem>
          ) : null}
          {canCreateService ? (
            <DropdownMenuItem onClick={openStack}>Compose</DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      <ConnectRepoDialog
        environmentName={environmentName}
        onOpenChange={closeDialog}
        open={dialog === "repo"}
        projectName={projectName}
        servers={servers}
      />
      <ConnectStackDialog
        environmentName={environmentName}
        onOpenChange={closeDialog}
        open={dialog === "stack"}
        projectName={projectName}
        servers={servers}
      />
      <ConnectDatabaseDialog
        environmentName={environmentName}
        onOpenChange={closeDialog}
        open={dialog === "database"}
        projectName={projectName}
        servers={servers}
      />
    </>
  );
}
