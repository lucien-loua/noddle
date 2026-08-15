import { PlugsIcon } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { GithubIcon } from "@/components/features/services/provider-icons";
import { useResourceList } from "@/components/features/settings-list/hooks/use-resource-list";
import { useRowRemove } from "@/components/features/settings-list/hooks/use-row-remove";
import { SettingsList } from "@/components/features/settings-list/settings-list";
import { IconStack } from "@/components/icon-stack";
import { RelativeTime } from "@/components/relative-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "@/components/ui/toast";
import { errorMessage } from "@/lib/format";
import type { RoleName } from "@/lib/permissions";
import { queries } from "@/lib/queries";
import { useCan } from "@/lib/use-permission";
import {
  deleteGitProvider,
  type GitProviderView,
  startGithubApp,
  startGitlabApp,
  syncGithubInstallation,
} from "@/server/git-providers";

function ProviderRow({
  onRemoved,
  provider,
  role,
}: {
  onRemoved: () => void;
  provider: GitProviderView;
  role: RoleName | null;
}) {
  const canDelete = useCan(role, "gitProvider", "delete");
  const queryClient = useQueryClient();

  // GitHub only redirects back after an install when the App carries a
  // `setup_url`, and an App created before that did not. Asking the App
  // what it is installed on recovers the fact either way.
  const sync = useMutation({
    mutationFn: () =>
      syncGithubInstallation({ data: { gitProviderId: provider.id } }),
    onError: (e: Error) =>
      toast.add({
        description: errorMessage(e, "could not check the installation"),
        title: "Not connected",
        type: "error",
      }),
    onSuccess: async (result) => {
      if ("pending" in result) {
        toast.add({
          description: "Install it on an account first, then check again.",
          title: "Not installed yet",
          type: "error",
        });
        return;
      }
      toast.add({
        description: `Installed on ${result.account}.`,
        title: "Connected",
        type: "success",
      });
      await queryClient.invalidateQueries();
      onRemoved();
    },
  });
  const handleSync = useCallback(() => sync.mutate(), [sync]);

  const { error, handleRemove, isPending } = useRowRemove({
    mutationFn: () =>
      deleteGitProvider({ data: { gitProviderId: provider.id } }),
    onRemoved,
  });

  return (
    <TableRow>
      <TableCell className="font-medium">
        {provider.name}
        {error ? (
          <span className="block text-destructive text-xs" role="status">
            {error}
          </span>
        ) : null}
      </TableCell>
      <TableCell className="text-muted-foreground text-sm">
        {provider.providerType === "gitlab" ? "GitLab" : "GitHub"}
      </TableCell>
      <TableCell>
        {provider.connected ? (
          <Badge variant="secondary">Connected</Badge>
        ) : (
          <Badge variant="outline">Not installed</Badge>
        )}
      </TableCell>
      <TableCell className="text-muted-foreground text-sm">
        {provider.serviceCount}
      </TableCell>
      <TableCell className="text-muted-foreground text-sm">
        <RelativeTime iso={provider.createdAt} />
      </TableCell>
      <TableCell className="text-end">
        <div className="flex justify-end gap-1">
          {/* An App that exists but is installed nowhere can list no
              repository. Finishing it is the only useful action left. */}
          {provider.installUrl ? (
            <Button
              render={
                <a href={provider.installUrl} rel="noreferrer" target="_blank">
                  Install
                </a>
              }
              size="sm"
              variant="outline"
            />
          ) : null}
          {provider.installUrl ? (
            <Button
              disabled={sync.isPending}
              onClick={handleSync}
              size="sm"
              variant="ghost"
            >
              {sync.isPending ? <Spinner data-icon="inline-start" /> : null}I
              have installed it
            </Button>
          ) : null}
          {canDelete ? (
            <Button
              disabled={isPending}
              onClick={handleRemove}
              size="sm"
              variant="ghost"
            >
              {isPending ? <Spinner /> : null}
              Remove
            </Button>
          ) : null}
        </div>
      </TableCell>
    </TableRow>
  );
}

/**
 * Creating the App is a form POST the BROWSER makes to GitHub, not a call
 * we make: the App must belong to the operator's account (ADR-0019). So we
 * ask the server for the manifest, drop it into a real form, and submit it.
 */
function ConnectGithubDialog({
  onOpenChange,
  open,
}: {
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const [name, setName] = useState("");
  const formRef = useRef<HTMLFormElement>(null);
  const [posting, setPosting] = useState<{
    action: string;
    manifest: string;
  } | null>(null);

  const start = useMutation({
    mutationFn: () => startGithubApp({ data: { name } }),
    onSuccess: (result) =>
      setPosting({ action: result.action, manifest: result.manifest }),
  });

  // Submitted from an effect rather than inline: the form's fields only
  // exist once React has rendered the manifest into them.
  useEffect(() => {
    if (posting) {
      formRef.current?.submit();
    }
  }, [posting]);

  const handleName = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value),
    []
  );
  const handleStart = useCallback(() => start.mutate(), [start]);

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect GitHub</DialogTitle>
          <DialogDescription>
            Noddle creates a GitHub App in your own account. It never holds a
            shared credential — you approve the permissions on GitHub, and can
            revoke them there at any time.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <Field>
            <FieldLabel htmlFor="github-app-name">App name</FieldLabel>
            <FieldDescription>
              Must be unique across all of GitHub. Letters, digits and dashes.
            </FieldDescription>
            <Input
              autoComplete="off"
              id="github-app-name"
              onChange={handleName}
              placeholder="noddle-acme"
              value={name}
            />
          </Field>
          {start.isError ? (
            <p className="mt-3 text-destructive text-sm" role="alert">
              {errorMessage(start.error, "could not start the connection")}
            </p>
          ) : null}

          {posting ? (
            <form action={posting.action} method="post" ref={formRef}>
              <input name="manifest" type="hidden" value={posting.manifest} />
            </form>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <DialogClose render={<Button variant="outline">Cancel</Button>} />
          <Button
            disabled={name.trim() === "" || start.isPending || posting !== null}
            onClick={handleStart}
          >
            {start.isPending || posting ? (
              <Spinner data-icon="inline-start" />
            ) : null}
            Continue on GitHub
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * GitLab has no manifest: the operator creates the application on GitLab
 * FIRST, then pastes its id and secret here. So the redirect URI is shown
 * before anything else — it has to match what they registered, and GitLab
 * refuses a mismatch only after the browser has already left.
 */
function ConnectGitlabDialog({
  onOpenChange,
  open,
}: {
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const [name, setName] = useState("");
  const [applicationId, setApplicationId] = useState("");
  const [secret, setSecret] = useState("");
  const [url, setUrl] = useState("https://gitlab.com");

  const redirectUri =
    typeof window === "undefined"
      ? ""
      : `${window.location.origin}/api/git-providers/gitlab/callback`;

  const start = useMutation({
    mutationFn: () =>
      startGitlabApp({ data: { applicationId, name, secret, url } }),
    onError: (e: Error) =>
      toast.add({
        description: errorMessage(e, "could not start the connection"),
        title: "Not connected",
        type: "error",
      }),
    onSuccess: (result) => {
      window.location.href = result.authorizeUrl;
    },
  });

  const handleName = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value),
    []
  );
  const handleAppId = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) =>
      setApplicationId(e.target.value),
    []
  );
  const handleSecret = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => setSecret(e.target.value),
    []
  );
  const handleUrl = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => setUrl(e.target.value),
    []
  );
  const handleStart = useCallback(() => start.mutate(), [start]);

  const ready =
    name.trim() !== "" && applicationId.trim() !== "" && secret.trim() !== "";

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect GitLab</DialogTitle>
          <DialogDescription>
            Create an application on GitLab with the redirect URI below and the
            scopes api and read_repository, then paste its credentials here.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <Field>
            <FieldLabel htmlFor="gitlab-redirect">Redirect URI</FieldLabel>
            <FieldDescription>
              Register this exact value on GitLab. A mismatch is only refused
              after you have been sent there.
            </FieldDescription>
            <Input id="gitlab-redirect" readOnly value={redirectUri} />
          </Field>
          <Field>
            <FieldLabel htmlFor="gitlab-name">Name</FieldLabel>
            <Input
              autoComplete="off"
              id="gitlab-name"
              onChange={handleName}
              placeholder="acme-gitlab"
              value={name}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="gitlab-url">GitLab URL</FieldLabel>
            <FieldDescription>
              Change it for a self-hosted instance.
            </FieldDescription>
            <Input id="gitlab-url" onChange={handleUrl} value={url} />
          </Field>
          <Field>
            <FieldLabel htmlFor="gitlab-app-id">Application ID</FieldLabel>
            <Input
              autoComplete="off"
              id="gitlab-app-id"
              onChange={handleAppId}
              value={applicationId}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="gitlab-secret">Secret</FieldLabel>
            <Input
              autoComplete="off"
              id="gitlab-secret"
              onChange={handleSecret}
              type="password"
              value={secret}
            />
          </Field>
          {start.isError ? (
            <p className="mt-3 text-destructive text-sm" role="alert">
              {errorMessage(start.error, "could not start the connection")}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <DialogClose render={<Button variant="outline">Cancel</Button>} />
          <Button disabled={!ready || start.isPending} onClick={handleStart}>
            {start.isPending ? <Spinner data-icon="inline-start" /> : null}
            Continue on GitLab
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function GitProvidersList({
  initial,
  onAdd,
  role,
}: {
  initial: GitProviderView[];
  onAdd?: () => void;
  role: RoleName | null;
}) {
  const {
    data: rows,
    isEmpty,
    refresh,
  } = useResourceList(queries.gitProviders, initial);

  return (
    <SettingsList isEmpty={isEmpty}>
      <SettingsList.Empty>
        <SettingsList.EmptyMedia>
          <IconStack>
            <PlugsIcon className="size-5" weight="duotone" />
          </IconStack>
        </SettingsList.EmptyMedia>
        <SettingsList.EmptyHeader>
          <SettingsList.EmptyTitle>No connected forges</SettingsList.EmptyTitle>
          <SettingsList.EmptyDescription>
            Connect GitHub to pick repositories from a list, deploy private ones
            without managing a key, and get pushes delivered automatically.
          </SettingsList.EmptyDescription>
        </SettingsList.EmptyHeader>
        {onAdd ? (
          <SettingsList.EmptyContent>
            <Button onClick={onAdd}>
              <GithubIcon />
              Connect GitHub
            </Button>
          </SettingsList.EmptyContent>
        ) : null}
      </SettingsList.Empty>

      <SettingsList.Frame
        description="Forges Noddle can read repositories from. The App belongs to your account — its private key never leaves this server, and revoking it on GitHub revokes it here."
        title="Git providers"
      >
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Name</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Services</TableHead>
              <TableHead>Added</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <ProviderRow
                key={row.id}
                onRemoved={refresh}
                provider={row}
                role={role}
              />
            ))}
          </TableBody>
        </Table>
      </SettingsList.Frame>
    </SettingsList>
  );
}

export { ConnectGithubDialog, ConnectGitlabDialog };
