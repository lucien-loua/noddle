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
import { Button } from "@/components/ui/button";
import { type RoleName, roles } from "@/lib/permissions";
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
  // `getGitProviders` requires `gitProvider: read`, which only admins have:
  // without this the loader exception renders a bare error page.
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
  const [open, setOpen] = useState(false);
  const [gitlabOpen, setGitlabOpen] = useState(false);

  const handleAdd = useCallback(() => setOpen(true), []);
  const handleAddGitlab = useCallback(() => setGitlabOpen(true), []);

  return (
    <AppShell
      actions={
        canAdd ? (
          <div className="flex items-center gap-2">
            <Button onClick={handleAdd}>
              <GithubIcon />
              Connect GitHub
            </Button>
            <Button onClick={handleAddGitlab} variant="outline">
              <GitlabIcon />
              Connect GitLab
            </Button>
          </div>
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
        onAdd={canAdd ? handleAdd : undefined}
        role={known}
      />
    </AppShell>
  );
}
