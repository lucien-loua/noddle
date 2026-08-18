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
  /** `center` when the trigger sits in an empty state, `end` in the shell. */
  align?: "center" | "end";
  /** When provided, the dialogs ask for neither the project nor the
   *  environment again. */
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

  // A courtesy hide, as everywhere: the real refusal is in
  // `connectRepo`/`connectStack`/`connectDatabase`.
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
