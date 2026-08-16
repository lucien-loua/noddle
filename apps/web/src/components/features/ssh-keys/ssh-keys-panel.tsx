import { KeyIcon, TagIcon } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { SubmitEvent } from "react";
import { useCallback, useEffect, useState } from "react";
import { z } from "zod";

import { useResourceList } from "@/components/features/settings-list/hooks/use-resource-list";
import { useRowRemove } from "@/components/features/settings-list/hooks/use-row-remove";
import { RevealOnceAlert } from "@/components/features/settings-list/reveal-once";
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
import { FieldGroup } from "@/components/ui/field";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FrameTitle,
} from "@/components/ui/frame";
import { Spinner } from "@/components/ui/spinner";
import { errorMessage } from "@/lib/format";
import { mutations } from "@/lib/mutations";
import type { RoleName } from "@/lib/permissions";
import { queries } from "@/lib/queries";
import { useCan } from "@/lib/use-permission";
import { deleteSshKey } from '@/server/ssh-keys';
import type { SshKeyView } from '@/server/ssh-keys';

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
  const { error, handleRemove, isPending } = useRowRemove({
    mutationFn: () => deleteSshKey({ data: { sshKeyId: sshKey.id } }),
    onRemoved,
  });

  // The refusal is SYNCHRONOUS — the foreign key is `restrict` — so no
  // confirmation dialog asking to retype the name: nothing is destroyed
  // as long as a machine still uses it, and the count is already on
  // screen.
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
                ? "This key still opens a server — remove it first"
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
        <p className="mt-2 text-destructive text-xs" role="status">
          {error}
        </p>
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

  return (
    <SettingsList isEmpty={isEmpty}>
      <SettingsList.Empty>
        <SettingsList.EmptyMedia>
          <IconStack>
            <KeyIcon className="size-5" />
          </IconStack>
        </SettingsList.EmptyMedia>
        <SettingsList.EmptyHeader>
          <SettingsList.EmptyTitle>No SSH keys</SettingsList.EmptyTitle>
          <SettingsList.EmptyDescription>
            A key is how Noddle reaches your machines. Generating one keeps the
            private half here, encrypted — it never leaves this server.
          </SettingsList.EmptyDescription>
        </SettingsList.EmptyHeader>
        {onAdd ? (
          <SettingsList.EmptyContent>
            <Button onClick={onAdd}>Add a key</Button>
          </SettingsList.EmptyContent>
        ) : null}
      </SettingsList.Empty>

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
    </SettingsList>
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
