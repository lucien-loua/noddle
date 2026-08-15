import { PlugsIcon } from "@phosphor-icons/react";
import { useMutation } from "@tanstack/react-query";
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
import { errorMessage } from "@/lib/format";
import type { RoleName } from "@/lib/permissions";
import { queries } from "@/lib/queries";
import { useCan } from "@/lib/use-permission";
import {
  deleteGitProvider,
  type GitProviderView,
  startGithubApp,
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
      <TableCell className="text-muted-foreground text-sm">GitHub</TableCell>
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
                <a href={provider.installUrl} rel="noreferrer">
                  Install
                </a>
              }
              size="sm"
              variant="outline"
            />
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
  const [publicUrl, setPublicUrl] = useState("");
  const formRef = useRef<HTMLFormElement>(null);
  const [posting, setPosting] = useState<{
    action: string;
    manifest: string;
  } | null>(null);

  const start = useMutation({
    mutationFn: () => startGithubApp({ data: { name, publicUrl } }),
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
  const handlePublicUrl = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => setPublicUrl(e.target.value),
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
          <Field>
            <FieldLabel htmlFor="github-public-url">
              Public URL (optional)
            </FieldLabel>
            <FieldDescription>
              Only needed while developing. GitHub has to reach this dashboard
              to deliver webhooks, so a localhost address is refused — put a
              tunnel URL here instead.
            </FieldDescription>
            <Input
              autoComplete="off"
              id="github-public-url"
              onChange={handlePublicUrl}
              placeholder="https://noddle.example.com"
              value={publicUrl}
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

export { ConnectGithubDialog };
