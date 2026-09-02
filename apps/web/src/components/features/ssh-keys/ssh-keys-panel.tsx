import { KeyIcon, TagIcon } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { SubmitEvent } from "react";
import { useCallback, useEffect, useState } from "react";
import { z } from "zod";

import { useResourceList } from "@/components/features/settings-list/hooks/use-resource-list";
import { useRowRemove } from "@/components/features/settings-list/hooks/use-row-remove";
import { RevealOnceAlert } from "@/components/features/settings-list/reveal-once";
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
import { errorMessage } from "@/lib/format";
import { mutations } from "@/lib/mutations";
import type { RoleName } from "@/lib/permissions";
import { queries } from "@/lib/queries";
import { useCan } from "@/lib/use-permission";
import { deleteSshKey } from "@/server/ssh-keys";
import type { SshKeyView } from "@/server/ssh-keys";

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

const sshKeyFormSchema = z
  .object({
    keyType: z.enum(["ed25519", "rsa"], "Choose a key type."),
    mode: z.enum(
      ["generate", "import"],
      "Choose whether to generate or import a key."
    ),
    name: z
      .string()
      .min(1, "Give this key a name.")
      .max(64, "Keep the name under 64 characters."),
    privateKey: z.string(),
  })
  .refine(
    (v) =>
      v.mode !== "import" ||
      (v.privateKey.includes("-----BEGIN") &&
        v.privateKey.includes("PRIVATE KEY")),
    {
      message: "Paste a PEM private key, not the .pub public key.",
      path: ["privateKey"],
    }
  );

interface SshKeyFormValues {
  keyType: "ed25519" | "rsa";
  mode: "generate" | "import";
  name: string;
  privateKey: string;
}

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
  const { error, handleRemove, isPending } = useRowRemove({
    mutationFn: () => deleteSshKey({ data: { sshKeyId: sshKey.id } }),
    onRemoved,
  });

  const used = sshKey.serverCount > 0;
  const algorithm = algorithmOf(sshKey.publicKey);

  return (
    <ResourceCard
      actions={
        canDelete ? (
          <Button
            disabled={isPending || used}
            onClick={handleRemove}
            size="sm"
            title={
              used
                ? "This key still opens a server. Remove it first"
                : undefined
            }
            variant="ghost"
          >
            {isPending ? <Spinner data-icon="inline-start" /> : null}
            Remove
          </Button>
        ) : null
      }
      title={
        <>
          <h2 className="truncate font-semibold text-sm">{sshKey.name}</h2>
          <Badge variant={used ? "secondary" : "outline"}>
            {used
              ? `opens ${sshKey.serverCount} server${sshKey.serverCount > 1 ? "s" : ""}`
              : "not used yet"}
          </Badge>
        </>
      }
    >
      <ResourceCardMeta>
        <ResourceCardFact label="Algorithm" value={algorithm ?? "—"} />
        <ResourceCardFact
          label="Added"
          value={<RelativeTime iso={sshKey.createdAt} />}
        />
      </ResourceCardMeta>
      {error ? (
        <output className="block mt-2 text-destructive text-xs">{error}</output>
      ) : null}
    </ResourceCard>
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
  const {
    data: rows,
    isEmpty,
    refresh,
  } = useResourceList(queries.sshKeys, initial);

  return isEmpty ? (
    <Frame className="flex h-full min-h-0 flex-col" variant="ghost">
      <FramePanel className="flex min-h-0 flex-1 flex-col">
        <Empty className="min-h-0 flex-1 border-0">
          <EmptyHeader>
            <EmptyMedia>
              <IconStack>
                <KeyIcon className="size-5" />
              </IconStack>
            </EmptyMedia>
            <EmptyTitle>No SSH keys</EmptyTitle>
            <EmptyDescription>
              A key is how Noddle reaches your machines. Generating one keeps
              the private half here, encrypted. It never leaves this server.
            </EmptyDescription>
          </EmptyHeader>
          {onAdd ? (
            <EmptyContent>
              <Button onClick={onAdd}>
                <KeyIcon data-icon="inline-start" weight="regular" />
                Add a key
              </Button>
            </EmptyContent>
          ) : null}
        </Empty>
      </FramePanel>
    </Frame>
  ) : (
    <Frame className="w-full" variant="ghost">
      <FrameHeader>
        <FrameTitle>SSH keys</FrameTitle>
        <FrameDescription>
          A key is how Noddle reaches your machines, and can read a private
          repository. It never leaves this server, encrypted at rest.
        </FrameDescription>
      </FrameHeader>
      {rows.map((k) => (
        <KeyRow key={k.id} onRemoved={refresh} role={role} sshKey={k} />
      ))}
    </Frame>
  );
}

function PublicKeyResult({ publicKey }: { publicKey: string }) {
  return (
    <RevealOnceAlert label="public key" value={publicKey}>
      <p className="mb-2">
        Add this to <code>~/.ssh/authorized_keys</code> on the machines this key
        should open. Noddle keeps the private half encrypted and never shows it.
      </p>
    </RevealOnceAlert>
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

  const add = useMutation(mutations.createSshKey(queryClient));

  const form = useAppForm({
    defaultValues: {
      keyType: "ed25519",
      mode: "generate",
      name: "",
      privateKey: "",
    } as SshKeyFormValues,
    onSubmit: async ({ value }) => {
      const result = await add.mutateAsync(
        value.mode === "generate"
          ? { mode: "generate", name: value.name, type: value.keyType }
          : {
              mode: "import",
              name: value.name,
              privateKey: value.privateKey,
            }
      );
      setCreated(result.publicKey);
    },
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
                              description="Passphrase-protected keys are not supported: Noddle would have nowhere to ask for it at deploy time."
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
