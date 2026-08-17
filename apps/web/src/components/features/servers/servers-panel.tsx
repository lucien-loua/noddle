import { serverInputSchema } from "@noddle/shared/validation/server";
import {
  GlobeIcon,
  HardDrivesIcon,
  TagIcon,
  UserIcon,
} from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { SubmitEvent } from "react";
import { useCallback, useEffect, useState } from "react";
import { z } from "zod";

import { DeleteServerAction } from "@/components/delete-server-action";
import { useResourceList } from "@/components/features/settings-list/hooks/use-resource-list";
import { SettingsList } from "@/components/features/settings-list/settings-list";
import { useAppForm } from "@/components/fields/lib/form";
import { IconStack } from "@/components/icon-stack";
import { RelativeTime } from "@/components/relative-time";
import {
  ResourceCard,
  ResourceCardFact,
  ResourceCardMeta,
} from "@/components/resource-card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogForm,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FieldGroup, FieldLegend, FieldSet } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { cache } from "@/lib/cache";
import { errorMessage } from "@/lib/format";
import { mutations } from "@/lib/mutations";
import type { RoleName } from "@/lib/permissions";
import { queries } from "@/lib/queries";
import { cn } from "@/lib/utils";
import type { ServerView } from "@/server/servers";

/** The badge and the dot share the same vocabulary as services:
 *  "connected" reads like "running", with no new color code to learn for
 *  this screen. */
const statusTone = (status: ServerView["status"]) => {
  if (status === "connected") {
    return "ok";
  }
  if (status === "unreachable") {
    return "danger";
  }
  return "busy";
};

const STATUS_LABEL: Record<ServerView["status"], string> = {
  connected: "Connected",
  pending: "Provisioning…",
  unreachable: "Unreachable",
};

/** A `pending` server only stays that way for the duration of
 *  provisioning — a few dozen seconds. Polling stops on its own once
 *  there are none left, so as not to hammer Redis/Postgres continuously
 *  for no reason. */
const POLL_MS = 3000;

const ServerRow = ({
  onRemoved,
  role,
  server,
}: {
  onRemoved: () => void;
  role: RoleName | null;
  server: ServerView;
}) => {
  const navigate = useNavigate();
  const tone = statusTone(server.status);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const accessError = server.status === "unreachable" ? server.lastError : null;
  const secondaryError = removeError ?? accessError;

  // The card leads to the detail view: a machine's resources are read on
  // ITS OWN page, which is what lets this stay a summary.
  const handleOpen = useCallback(
    () =>
      navigate({ params: { serverId: server.id }, to: "/servers/$serverId" }),
    [navigate, server.id]
  );

  return (
    <ResourceCard
      actions={
        <DeleteServerAction
          onError={setRemoveError}
          onRemoved={onRemoved}
          role={role}
          serverId={server.id}
          serverName={server.name}
        />
      }
      onOpen={handleOpen}
      title={
        <>
          <span
            aria-hidden="true"
            className={cn(
              "size-2 shrink-0 rounded-full",
              tone === "ok" && "bg-success",
              tone === "danger" && "bg-destructive",
              tone === "busy" && "bg-muted-foreground"
            )}
          />
          <h2 className="truncate font-semibold text-sm">{server.name}</h2>
          <Badge variant="outline">{STATUS_LABEL[server.status]}</Badge>
          {server.role === "manager" ? (
            <Badge variant="secondary">manager</Badge>
          ) : null}
        </>
      }
    >
      <ResourceCardMeta>
        <ResourceCardFact label="Host" value={server.host} />
        <ResourceCardFact label="Docker" value={server.dockerVersion ?? "—"} />
        <ResourceCardFact
          label="Memory"
          value={server.totalMemoryMb ? `${server.totalMemoryMb} MB` : "—"}
        />
        <ResourceCardFact
          label="Added"
          value={<RelativeTime iso={server.createdAt} />}
        />
      </ResourceCardMeta>
      {secondaryError ? (
        <output className="mt-2 text-destructive text-xs">
          {secondaryError}
        </output>
      ) : null}
    </ResourceCard>
  );
};

export const ServersList = ({
  initial,
  onAdd,
  role,
}: {
  initial: ServerView[];
  /** Absent when the role can't add: the empty state then simply
   *  explains it, without offering a button that would be refused. */
  onAdd?: () => void;
  role: RoleName | null;
}) => {
  const queryClient = useQueryClient();
  const { data: servers, isEmpty } = useResourceList(queries.servers, initial, {
    refetchInterval: (query) =>
      query.state.data?.some((s) => s.status === "pending") ? POLL_MS : false,
  });

  const handleRemoved = useCallback(
    () => cache.servers(queryClient),
    [queryClient]
  );

  return (
    <SettingsList isEmpty={isEmpty}>
      <SettingsList.Empty>
        <SettingsList.EmptyMedia>
          <IconStack>
            <HardDrivesIcon className="size-5" />
          </IconStack>
        </SettingsList.EmptyMedia>
        <SettingsList.EmptyHeader>
          <SettingsList.EmptyTitle>No servers yet</SettingsList.EmptyTitle>
          <SettingsList.EmptyDescription>
            Noddle deploys onto machines you own. Add one before you can deploy
            anything.
          </SettingsList.EmptyDescription>
        </SettingsList.EmptyHeader>
        {onAdd ? (
          <SettingsList.EmptyContent>
            <Button onClick={onAdd}>Add a server</Button>
          </SettingsList.EmptyContent>
        ) : null}
      </SettingsList.Empty>

      <SettingsList.Frame
        panel={false}
        description="Machines Noddle deploys onto. Open one to see its resources, disk and toolchain."
        title="Servers"
      >
        {servers.map((server) => (
          <ServerRow
            key={server.id}
            onRemoved={handleRemoved}
            role={role}
            server={server}
          />
        ))}
      </SettingsList.Frame>
    </SettingsList>
  );
};

const serverFormSchema = serverInputSchema.extend({
  sshPort: z
    .number()
    .int()
    .min(1)
    .max(65_535)
    .nullable()
    .refine((v) => v !== null, "Port is required."),
});

type ServerFormValues = z.input<typeof serverFormSchema>;

export function AddServerDialog({
  onOpenChange,
  open,
}: {
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const queryClient = useQueryClient();

  // The library's keys. Loaded HERE rather than passed through the
  // route: the dialog is the only one that needs them, and it must see
  // them again after a round trip to /ssh-keys without reloading the
  // page.
  const keys = useQuery(queries.sshKeys());
  const available = keys.data ?? [];

  const add = useMutation(mutations.addServer(queryClient));

  const form = useAppForm({
    defaultValues: {
      host: "",
      name: "",
      sshKeyId: "",
      sshPort: 22,
      sshUser: "root",
    } as ServerFormValues,
    onSubmit: async ({ value }) => {
      await add.mutateAsync({
        host: value.host,
        name: value.name,
        sshKeyId: value.sshKeyId,
        sshPort: value.sshPort ?? 22,
        sshUser: value.sshUser,
      });
      onOpenChange(false);
    },
    validators: { onDynamic: serverFormSchema },
  });

  // A form is never opened twice in a row in the same state: closing
  // without saving must start fresh on the next open.
  useEffect(() => {
    if (open) {
      form.reset();
    }
  }, [open, form.reset]);

  const handleSubmit = useCallback(
    (event: SubmitEvent) => {
      event.preventDefault();
      form.handleSubmit();
    },
    [form]
  );

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a server</DialogTitle>
          <DialogDescription>
            A host and a key from your library are all it takes. Noddle installs
            Docker if missing, joins its Swarm cluster as a worker, and installs
            railpack — with nothing else to do by hand on that machine.
          </DialogDescription>
        </DialogHeader>

        <DialogForm onSubmit={handleSubmit}>
          <DialogBody>
            <FieldGroup>
              <FieldSet>
                <FieldLegend variant="label">Machine</FieldLegend>
                <form.AppField name="name">
                  {(f) => (
                    <f.FieldText
                      addonStart={<TagIcon />}
                      label="Name"
                      placeholder="vps-lyon"
                      required
                    />
                  )}
                </form.AppField>
                <form.AppField name="host">
                  {(f) => (
                    <f.FieldText
                      addonStart={<GlobeIcon />}
                      label="Host"
                      placeholder="203.0.113.7"
                      required
                    />
                  )}
                </form.AppField>
                <div className="grid grid-cols-2 gap-3">
                  <form.AppField name="sshUser">
                    {(f) => (
                      <f.FieldText
                        addonStart={<UserIcon />}
                        label="SSH user"
                        required
                      />
                    )}
                  </form.AppField>
                  <form.AppField name="sshPort">
                    {(f) => <f.FieldNumber label="Port" min={1} required />}
                  </form.AppField>
                </div>
              </FieldSet>

              <form.AppField name="sshKeyId">
                {(f) => (
                  <f.FieldCombobox
                    description="Picked from your library, where it is encrypted at rest. The same key can open several machines — add one under SSH keys if the list is empty."
                    emptyText="No key matches."
                    items={available}
                    // biome-ignore lint/performance/noJsxPropsBind: inline for type inference from items={available}
                    itemToId={(key) => key.id}
                    // biome-ignore lint/performance/noJsxPropsBind: inline for type inference
                    itemToStringLabel={(key) => key.name}
                    // biome-ignore lint/performance/noJsxPropsBind: inline for type inference
                    itemToStringValue={(key) => key.name}
                    label="SSH key"
                    placeholder="Search keys…"
                    // biome-ignore lint/performance/noJsxPropsBind: inline for type inference
                    renderItem={(key) => (
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <span className="truncate">{key.name}</span>
                        <span className="font-normal text-muted-foreground text-xs">
                          {key.serverCount === 0
                            ? "not used yet"
                            : `opens ${key.serverCount} server${key.serverCount > 1 ? "s" : ""}`}
                        </span>
                      </span>
                    )}
                    required
                  />
                )}
              </form.AppField>

              {add.isError ? (
                <Alert variant="destructive">
                  <AlertDescription>
                    {errorMessage(add.error, "could not add server")}
                  </AlertDescription>
                </Alert>
              ) : null}
            </FieldGroup>
          </DialogBody>

          <DialogFooter>
            <Button disabled={add.isPending} type="submit">
              {add.isPending ? <Spinner data-icon="inline-start" /> : null}
              Add server
            </Button>
          </DialogFooter>
        </DialogForm>
      </DialogContent>
    </Dialog>
  );
}
