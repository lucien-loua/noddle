import { serverInputSchema } from "@noddle/shared/validation";
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
import { useAppForm } from "@/components/fields/lib/form";
import { IconStack } from "@/components/icon-stack";
import { ResourceRow, RowGroup } from "@/components/resource-row";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { FieldGroup, FieldLegend, FieldSet } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { errorMessage } from "@/lib/format";
import type { RoleName } from "@/lib/permissions";
import { addServer, getServers, type ServerView } from "@/server/servers";
import { getSshKeys } from "@/server/ssh-keys";

/** The badge and the dot share the same vocabulary as services:
 *  "connected" reads like "running", with no new color code to learn for
 *  this screen. */
function statusTone(status: ServerView["status"]) {
  if (status === "connected") {
    return "ok";
  }
  if (status === "unreachable") {
    return "danger";
  }
  return "busy";
}

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

function ServerRow({
  onRemoved,
  role,
  server,
}: {
  onRemoved: () => void;
  role: RoleName | null;
  server: ServerView;
}) {
  const navigate = useNavigate();
  const tone = statusTone(server.status);
  const facts = [
    server.host,
    server.role === "manager" ? "manager" : null,
    server.dockerVersion ? `Docker ${server.dockerVersion}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const [removeError, setRemoveError] = useState<string | null>(null);
  const accessError = server.status === "unreachable" ? server.lastError : null;
  const secondaryError = removeError ?? accessError;

  // The row leads to the detail view, exactly like the dashboard's rows.
  // This is what allows removing the flat list of cards that used to live
  // under it: a machine's resources are read on ITS OWN page.
  const handleOpen = useCallback(
    () =>
      navigate({ params: { serverId: server.id }, to: "/servers/$serverId" }),
    [navigate, server.id]
  );

  return (
    <ResourceRow
      action={
        <DeleteServerAction
          onError={setRemoveError}
          onRemoved={onRemoved}
          role={role}
          serverId={server.id}
          serverName={server.name}
        />
      }
      name={server.name}
      onToggle={handleOpen}
      secondary={
        secondaryError ? (
          <span className="text-destructive" role="status">
            {secondaryError}
          </span>
        ) : (
          facts
        )
      }
      tone={tone}
      toneLabel={STATUS_LABEL[server.status]}
    />
  );
}

export function ServersList({
  initial,
  onAdd,
  role,
}: {
  initial: ServerView[];
  /** Absent when the role can't add: the empty state then simply
   *  explains it, without offering a button that would be refused. */
  onAdd?: () => void;
  role: RoleName | null;
}) {
  const queryClient = useQueryClient();
  const serversQuery = useQuery({
    initialData: initial,
    queryFn: () => getServers(),
    queryKey: ["servers"],
    refetchInterval: (query) =>
      query.state.data?.some((s) => s.status === "pending") ? POLL_MS : false,
  });
  const servers = serversQuery.data ?? initial;

  const handleRemoved = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ["servers"] }),
    [queryClient]
  );

  if (servers.length === 0) {
    return (
      <Empty className="h-full">
        <EmptyMedia>
          <IconStack>
            <HardDrivesIcon className="size-5" weight="duotone" />
          </IconStack>
        </EmptyMedia>
        <EmptyHeader>
          <EmptyTitle>No servers yet</EmptyTitle>
          <EmptyDescription>
            Noddle deploys onto machines you own. Add one before you can deploy
            anything.
          </EmptyDescription>
        </EmptyHeader>
        {onAdd ? (
          <EmptyContent>
            <Button onClick={onAdd}>Add a server</Button>
          </EmptyContent>
        ) : null}
      </Empty>
    );
  }

  return (
    <RowGroup>
      {servers.map((server) => (
        <ServerRow
          key={server.id}
          onRemoved={handleRemoved}
          role={role}
          server={server}
        />
      ))}
    </RowGroup>
  );
}

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
  const keys = useQuery({
    queryFn: () => getSshKeys(),
    queryKey: ["ssh-keys"],
  });
  const available = keys.data ?? [];

  const add = useMutation({
    mutationFn: (value: ServerFormValues) =>
      addServer({
        data: {
          host: value.host,
          name: value.name,
          sshKeyId: value.sshKeyId,
          sshPort: value.sshPort ?? 22,
          sshUser: value.sshUser,
        },
      }),
    onSuccess: async () => {
      onOpenChange(false);
      await queryClient.invalidateQueries({ queryKey: ["servers"] });
    },
  });

  const form = useAppForm({
    defaultValues: {
      host: "",
      name: "",
      sshKeyId: "",
      sshPort: 22,
      sshUser: "root",
    } as ServerFormValues,
    onSubmit: ({ value }) => add.mutateAsync(value),
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
            nixpacks — with nothing else to do by hand on that machine.
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
