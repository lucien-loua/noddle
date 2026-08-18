import { PlugsIcon, TrashIcon } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  GithubIcon,
  GitlabIcon,
} from "@/components/features/services/provider-icons";
import { useResourceList } from "@/components/features/settings-list/hooks/use-resource-list";
import { useRowRemove } from "@/components/features/settings-list/hooks/use-row-remove";
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
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@/components/ui/frame";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { errorMessage } from "@/lib/format";
import type { RoleName } from "@/lib/permissions";
import { queries } from "@/lib/queries";
import { useCan } from "@/lib/use-permission";
import {
  deleteGitProvider,
  startGithubApp,
  startGitlabApp,
  syncGithubInstallation,
} from "@/server/git-providers";
import type { GitProviderView } from "@/server/git-providers";

const TRAILING_SLASHES = /\/+$/;

/** The URL if it is http(s), `null` otherwise — including while typing. */
function httpUrlOrNull(candidate: string): string | null {
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === "https:" || parsed.protocol === "http:"
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
}

function Meta({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="truncate font-medium text-sm">{value}</dd>
    </div>
  );
}

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
    <FramePanel>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {provider.providerType === "gitlab" ? (
              <GitlabIcon />
            ) : (
              <GithubIcon />
            )}
            <h2 className="truncate font-semibold text-sm">{provider.name}</h2>
            {provider.connected ? (
              <Badge variant="secondary">Connected</Badge>
            ) : (
              <Badge variant="outline">Not installed</Badge>
            )}
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
            <Meta label="Services" value={provider.serviceCount} />
            <Meta
              label="Added"
              value={<RelativeTime iso={provider.createdAt} />}
            />
          </dl>
          {error ? (
            <output className="block mt-2 text-destructive text-xs">
              {error}
            </output>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {/* An App that exists but is installed nowhere can list no
              repository. Finishing it is the only useful action left. */}
          {provider.installUrl ? (
            <>
              <Button
                render={
                  <a
                    href={provider.installUrl}
                    rel="noreferrer"
                    target="_blank"
                  >
                    Install
                  </a>
                }
                size="sm"
                variant="outline"
              />
              <Button
                disabled={sync.isPending}
                onClick={handleSync}
                size="sm"
                variant="ghost"
              >
                {sync.isPending ? <Spinner data-icon="inline-start" /> : null}I
                have installed it
              </Button>
            </>
          ) : null}
          {canDelete ? (
            <Button
              aria-label={`Remove ${provider.name}`}
              disabled={isPending}
              onClick={handleRemove}
              size="icon-sm"
              variant="ghost"
            >
              {isPending ? <Spinner /> : <TrashIcon />}
            </Button>
          ) : null}
        </div>
      </div>
    </FramePanel>
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
          <FieldGroup>
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
              <FieldError>
                {errorMessage(start.error, "could not start the connection")}
              </FieldError>
            ) : null}
          </FieldGroup>

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

  // Derived from the instance the user typed, so a self-hosted GitLab gets
  // its OWN link rather than one pointing at gitlab.com.
  //
  // Only http(s) becomes a link. Typed here it would only ever be the
  // author's own session, but a scheme reaching an `href` unchecked is a
  // shape not worth shipping — and half-typed input stops rendering a
  // nonsensical link on the way.
  const applicationsUrl = httpUrlOrNull(
    `${url.replace(TRAILING_SLASHES, "")}/-/user_settings/applications`
  );

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
          {/* `FieldGroup` and not five loose `Field`: `DialogBody` is a
              scroll container with no vertical rhythm of its own, so the
              fields were touching. The gap between fields belongs to the
              group, exactly as the gap between a label and its input
              belongs to `Field`. */}
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="gitlab-redirect">Redirect URI</FieldLabel>
              <FieldDescription>
                Create the application at{" "}
                {applicationsUrl ? (
                  <a
                    className="underline"
                    href={applicationsUrl}
                    rel="noreferrer"
                    target="_blank"
                  >
                    {applicationsUrl}
                  </a>
                ) : (
                  <span className="font-mono">
                    {url}/-/user_settings/applications
                  </span>
                )}{" "}
                with scopes <code className="font-mono">api</code> and{" "}
                <code className="font-mono">read_repository</code>, and register
                this exact URI. A mismatch is only refused once GitLab has
                already taken you there.
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
              <FieldError>
                {errorMessage(start.error, "could not start the connection")}
              </FieldError>
            ) : null}
          </FieldGroup>
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
  onAddGithub,
  onAddGitlab,
  role,
}: {
  initial: GitProviderView[];
  onAddGithub?: () => void;
  onAddGitlab?: () => void;
  role: RoleName | null;
}) {
  const {
    data: rows,
    isEmpty,
    refresh,
  } = useResourceList(queries.gitProviders, initial);

  return isEmpty ? (
    <Frame className="flex h-full min-h-0 flex-col" variant="ghost">
      <FramePanel className="flex min-h-0 flex-1 flex-col">
        <Empty className="min-h-0 flex-1 border-0">
          <EmptyHeader>
            <EmptyMedia>
              <IconStack>
                <PlugsIcon className="size-5" />
              </IconStack>
            </EmptyMedia>
            <EmptyTitle>No connected forges</EmptyTitle>
            <EmptyDescription>
              Connect GitHub or GitLab to pick repositories from a list, deploy
              private ones without managing a key, and get pushes delivered
              automatically.
            </EmptyDescription>
          </EmptyHeader>
          {onAddGithub && onAddGitlab ? (
            <EmptyContent>
              {/* Both spelled out here: with nothing connected, the choice of
                    forge IS the content of this screen. */}
              <div className="flex flex-wrap items-center justify-center gap-2">
                <Button onClick={onAddGithub}>
                  <GithubIcon />
                  Connect GitHub
                </Button>
                <Button onClick={onAddGitlab} variant="outline">
                  <GitlabIcon />
                  Connect GitLab
                </Button>
              </div>
            </EmptyContent>
          ) : null}
        </Empty>
      </FramePanel>
    </Frame>
  ) : (
    <Frame className="w-full" variant="ghost">
      <FrameHeader>
        <FrameTitle>Git providers</FrameTitle>
        <FrameDescription>
          Forges Noddle can read repositories from. The credentials belong to
          your account — they never leave this server, and revoking them on the
          forge revokes them here.
        </FrameDescription>
      </FrameHeader>
      {rows.map((row) => (
        <ProviderRow
          key={row.id}
          onRemoved={refresh}
          provider={row}
          role={role}
        />
      ))}
    </Frame>
  );
}

export { ConnectGithubDialog, ConnectGitlabDialog };
