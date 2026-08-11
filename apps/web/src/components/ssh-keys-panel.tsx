import { KeyIcon, TagIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SubmitEvent } from "react";
import { useCallback, useEffect, useState } from "react";
import { z } from "zod";
import { CopyableValue } from "@/components/copyable-value";
import { useAppForm } from "@/components/fields/lib/form";
import { IconStack } from "@/components/icon-stack";
import { RelativeTime } from "@/components/relative-time";
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
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { FieldGroup } from "@/components/ui/field";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@/components/ui/frame";
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
import { createSshKey, deleteSshKey, type SshKeyView } from "@/server/ssh-keys";

/** The algorithm, READ off the public key rather than stored:
 *  `ssh-ed25519 …` and `ssh-rsa …` already carry it. One more column
 *  could drift from the key it describes; here that's impossible by
 *  construction. */
function algorithmOf(publicKey: string | null): string | null {
  if (!publicKey) {
    return null;
  }
  const [prefix] = publicKey.split(" ");
  if (prefix === "ssh-ed25519") {
    return "Ed25519";
  }
  if (prefix === "ssh-rsa") {
    return "RSA";
  }
  return prefix ?? null;
}

// Flat, with a `mode`, rather than the server's discriminated union: the
// form shows ALL fields and toggles at display time. The private key is
// only required on import; its message is in English, whereas the shared
// schema has it in French (and also serves it server-side, out of scope
// here).
const sshKeyFormSchema = z
  .object({
    keyType: z.enum(["ed25519", "rsa"]),
    mode: z.enum(["generate", "import"]),
    name: z.string().min(1, "Give this key a name.").max(64),
    privateKey: z.string(),
  })
  .refine(
    (v) =>
      v.mode !== "import" ||
      (v.privateKey.includes("-----BEGIN") &&
        v.privateKey.includes("PRIVATE KEY")),
    {
      message: "Paste a PEM private key — not the .pub public key.",
      path: ["privateKey"],
    }
  );

interface SshKeyFormValues {
  keyType: "ed25519" | "rsa";
  mode: "generate" | "import";
  name: string;
  privateKey: string;
}

// Named and hoisted: an inline selector in `form.Subscribe` gets recreated
// on every render and forces a resubscribe.
function selectMode(state: { values: { mode: string } }) {
  return state.values.mode;
}

function KeyRow({
  onRemoved,
  role,
  sshKey,
}: {
  onRemoved: () => void;
  role: RoleName | null;
  sshKey: SshKeyView;
}) {
  const canDelete = useCan(role, "sshKey", "delete");
  const [error, setError] = useState<string | null>(null);

  const remove = useMutation({
    mutationFn: () => deleteSshKey({ data: { sshKeyId: sshKey.id } }),
    onError: (e: Error) => setError(errorMessage(e, "removal refused")),
    onSuccess: onRemoved,
  });
  const handleRemove = useCallback(() => remove.mutate(), [remove]);

  // The refusal is SYNCHRONOUS — the foreign key is `restrict` — so no
  // confirmation dialog asking to retype the name: nothing is destroyed
  // as long as a machine still uses it, and the count is already on
  // screen.
  const used = sshKey.serverCount > 0;
  const algorithm = algorithmOf(sshKey.publicKey);

  return (
    <TableRow>
      <TableCell className="font-medium">
        {sshKey.name}
        {error ? (
          <span className="block text-destructive text-xs" role="status">
            {error}
          </span>
        ) : null}
      </TableCell>
      <TableCell className="text-muted-foreground text-sm">
        {algorithm ?? "—"}
      </TableCell>
      <TableCell className="text-muted-foreground text-sm">
        <RelativeTime iso={sshKey.createdAt} />
      </TableCell>
      <TableCell>
        <Badge variant={used ? "secondary" : "outline"}>
          {used
            ? `opens ${sshKey.serverCount} server${sshKey.serverCount > 1 ? "s" : ""}`
            : "not used yet"}
        </Badge>
      </TableCell>
      <TableCell className="text-end">
        {canDelete ? (
          <Button
            disabled={remove.isPending || used}
            onClick={handleRemove}
            size="sm"
            title={
              used
                ? "This key still opens a server — remove it first"
                : undefined
            }
            variant="ghost"
          >
            {remove.isPending ? <Spinner /> : null}
            Remove
          </Button>
        ) : null}
      </TableCell>
    </TableRow>
  );
}

export function SshKeysList({
  initial,
  onAdd,
  role,
}: {
  initial: SshKeyView[];
  onAdd?: () => void;
  role: RoleName | null;
}) {
  const queryClient = useQueryClient();
  const keys = useQuery({ ...queries.sshKeys(), initialData: initial });

  const handleRemoved = useCallback(
    () =>
      queryClient.invalidateQueries({ queryKey: queries.sshKeys().queryKey }),
    [queryClient]
  );

  const rows = keys.data ?? initial;
  if (rows.length === 0) {
    return (
      <Empty className="h-full">
        <EmptyMedia>
          <IconStack>
            <KeyIcon className="size-5" weight="duotone" />
          </IconStack>
        </EmptyMedia>
        <EmptyHeader>
          <EmptyTitle>No SSH keys</EmptyTitle>
          <EmptyDescription>
            A key is how Noddle reaches your machines. Generating one keeps the
            private half here, encrypted — it never leaves this server.
          </EmptyDescription>
        </EmptyHeader>
        {onAdd ? (
          <EmptyContent>
            <Button onClick={onAdd}>Add a key</Button>
          </EmptyContent>
        ) : null}
      </Empty>
    );
  }

  return (
    <Frame variant="ghost">
      <FrameHeader>
        <FrameTitle>SSH keys</FrameTitle>
        <FrameDescription>
          A key is how Noddle reaches your machines, and can read a private
          repository. It never leaves this server, encrypted at rest.
        </FrameDescription>
      </FrameHeader>
      <FramePanel className="p-0">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Name</TableHead>
              <TableHead>Algorithm</TableHead>
              <TableHead>Added</TableHead>
              <TableHead>Status</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((k) => (
              <KeyRow
                key={k.id}
                onRemoved={handleRemoved}
                role={role}
                sshKey={k}
              />
            ))}
          </TableBody>
        </Table>
      </FramePanel>
    </Frame>
  );
}

/**
 * The public key, after creation.
 *
 * Shown ONCE and kept — unlike a webhook's secret, it isn't sensitive and
 * stays readable in the list afterward. What's highlighted here is the
 * next step: it must be dropped onto the target machine, without which
 * the key just created opens nothing.
 */
function PublicKeyResult({ publicKey }: { publicKey: string }) {
  return (
    <Alert>
      <AlertDescription className="min-w-0">
        <p className="mb-2">
          Add this to <code>~/.ssh/authorized_keys</code> on the machines this
          key should open. Noddle keeps the private half encrypted and never
          shows it.
        </p>
        <CopyableValue label="public key" value={publicKey} />
      </AlertDescription>
    </Alert>
  );
}

export function AddSshKeyDialog({
  onOpenChange,
  open,
}: {
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const queryClient = useQueryClient();
  const [created, setCreated] = useState<string | null>(null);

  const add = useMutation({
    mutationFn: (value: SshKeyFormValues) =>
      createSshKey({
        data:
          value.mode === "generate"
            ? { mode: "generate", name: value.name, type: value.keyType }
            : {
                mode: "import",
                name: value.name,
                privateKey: value.privateKey,
              },
      }),
    onSuccess: async (result) => {
      setCreated(result.publicKey);
      await queryClient.invalidateQueries({
        queryKey: queries.sshKeys().queryKey,
      });
    },
  });

  const form = useAppForm({
    defaultValues: {
      keyType: "ed25519",
      mode: "generate",
      name: "",
      privateKey: "",
    } as SshKeyFormValues,
    onSubmit: ({ value }) => add.mutateAsync(value),
    validators: { onDynamic: sshKeyFormSchema },
  });

  useEffect(() => {
    if (open) {
      form.reset();
      setCreated(null);
    }
  }, [open, form.reset]);

  const handleSubmit = useCallback(
    (event: SubmitEvent) => {
      event.preventDefault();
      form.handleSubmit();
    },
    [form]
  );
  const handleDone = useCallback(() => onOpenChange(false), [onOpenChange]);

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add an SSH key</DialogTitle>
          <DialogDescription>
            Noddle uses it to reach your servers, and can use it to read a
            private repository. It is encrypted at rest and never leaves this
            server.
          </DialogDescription>
        </DialogHeader>

        {created ? (
          <>
            <DialogBody>
              <PublicKeyResult publicKey={created} />
            </DialogBody>
            <DialogFooter>
              <Button onClick={handleDone}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <DialogForm onSubmit={handleSubmit}>
            <DialogBody>
              <FieldGroup>
                <form.AppField name="name">
                  {(f) => (
                    <f.FieldText
                      addonStart={<TagIcon />}
                      description="What you will pick from when adding a server."
                      label="Name"
                      placeholder="production"
                      required
                    />
                  )}
                </form.AppField>

                <form.AppField name="mode">
                  {(f) => (
                    <f.FieldRadio
                      options={[
                        {
                          description:
                            "The private half is created here and never shown.",
                          label: "Generate a new key",
                          value: "generate",
                        },
                        {
                          description:
                            "For a machine that already has a key you must use.",
                          label: "Paste an existing private key",
                          value: "import",
                        },
                      ]}
                    />
                  )}
                </form.AppField>

                <form.Subscribe selector={selectMode}>
                  {(mode) => (
                    <>
                      {mode === "generate" ? (
                        // FIXED list of two, each saying what its
                        // algorithm is for: exactly what `FieldSelect` is
                        // for.
                        <form.AppField name="keyType">
                          {(f) => (
                            <f.FieldSelect
                              label="Algorithm"
                              options={[
                                {
                                  description:
                                    "Short and fast. Accepted by every OpenSSH since 2014.",
                                  label: "Ed25519",
                                  value: "ed25519",
                                },
                                {
                                  description:
                                    "For a system that still refuses Ed25519.",
                                  label: "RSA 4096",
                                  value: "rsa",
                                },
                              ]}
                            />
                          )}
                        </form.AppField>
                      ) : null}

                      {mode === "import" ? (
                        <form.AppField name="privateKey">
                          {(f) => (
                            <f.FieldTextarea
                              className="min-h-32 font-mono text-xs"
                              description="Passphrase-protected keys are not supported — Noddle would have nowhere to ask for it at deploy time."
                              label="SSH private key, PEM format"
                              placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                              spellCheck={false}
                            />
                          )}
                        </form.AppField>
                      ) : null}
                    </>
                  )}
                </form.Subscribe>

                {add.isError ? (
                  <Alert variant="destructive">
                    <AlertDescription>
                      {errorMessage(add.error, "could not add the key")}
                    </AlertDescription>
                  </Alert>
                ) : null}
              </FieldGroup>
            </DialogBody>

            <DialogFooter>
              <form.Subscribe selector={selectMode}>
                {(mode) => (
                  <Button disabled={add.isPending} type="submit">
                    {add.isPending ? (
                      <Spinner data-icon="inline-start" />
                    ) : null}
                    {mode === "generate" ? "Generate key" : "Add key"}
                  </Button>
                )}
              </form.Subscribe>
            </DialogFooter>
          </DialogForm>
        )}
      </DialogContent>
    </Dialog>
  );
}
