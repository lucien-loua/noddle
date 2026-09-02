import { PlugsIcon } from "@phosphor-icons/react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useCallback, useState } from "react";

import { AppShell } from "@/components/app-shell";
import {
  ConnectGithubDialog,
  ConnectGitlabDialog,
  GitProvidersList,
} from "@/components/features/git-providers/git-providers-panel";
import {
  GithubIcon,
  GitlabIcon,
} from "@/components/features/services/provider-icons";
import { useResourceList } from "@/components/features/settings-list/hooks/use-resource-list";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { roles } from "@/lib/permissions";
import type { RoleName } from "@/lib/permissions";
import { queries } from "@/lib/queries";
import { useCan } from "@/lib/use-permission";
import { getAuthState } from "@/server/auth";
import { getGitProviders } from "@/server/git-providers";

export const Route = createFileRoute("/git-providers")({
  beforeLoad: async () => {
    const state = await getAuthState();
    if (!state.signedIn) {
      throw redirect({ to: "/login" });
    }
    return { email: state.email, role: state.role };
  },
  component: GitProvidersPage,
  errorComponent: () => (
    <p className="p-6 text-muted-foreground text-sm">
      Your role does not allow reading git providers.
    </p>
  ),
  loader: async ({ context }) => ({
    email: context.email,
    providers: await getGitProviders(),
    role: context.role,
  }),
});

function GitProvidersPage() {
  const { email, providers, role } = Route.useLoaderData();
  const known: RoleName | null =
    role && role in roles ? (role as RoleName) : null;
  const canAdd = useCan(known, "gitProvider", "create");
  const { isEmpty } = useResourceList(queries.gitProviders, providers);
  const [open, setOpen] = useState(false);
  const [gitlabOpen, setGitlabOpen] = useState(false);

  const handleAdd = useCallback(() => setOpen(true), []);
  const handleAddGitlab = useCallback(() => setGitlabOpen(true), []);

  return (
    <AppShell
      actions={
        canAdd && !isEmpty ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button>
                  <PlugsIcon data-icon="inline-start" weight="regular" />
                  Connect
                </Button>
              }
            />
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={handleAdd}>
                <GithubIcon />
                GitHub
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleAddGitlab}>
                <GitlabIcon />
                GitLab
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null
      }
      email={email}
      role={role}
      title="Git providers"
    >
      {canAdd ? (
        <>
          <ConnectGithubDialog onOpenChange={setOpen} open={open} />
          <ConnectGitlabDialog onOpenChange={setGitlabOpen} open={gitlabOpen} />
        </>
      ) : null}
      <GitProvidersList
        initial={providers}
        onAddGithub={canAdd ? handleAdd : undefined}
        onAddGitlab={canAdd ? handleAddGitlab : undefined}
        role={known}
      />
    </AppShell>
  );
}
