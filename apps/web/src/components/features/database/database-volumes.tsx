/**
 * biome-ignore-all lint/performance/noJsxPropsBind: controlled dialog forms;
 * extracting every setState wrapper adds noise without shared children.
 * biome-ignore-all lint/suspicious/noUnnecessaryConditions: Select values are string|null from Base UI.
 */

import {
  type DatabaseEngine,
  DEFAULT_DATABASE_VOLUME_PATH,
} from "@noddle/database-spec";
import type { DatabaseExtraMount } from "@noddle/db/schema";
import { PencilSimpleIcon, PlusIcon, TrashIcon } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { z } from "zod";
import { useAppForm } from "@/components/fields/lib/form";
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
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@/components/ui/frame";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { errorMessage } from "@/lib/format";
import {
  addDatabaseMount,
  deleteDatabaseMount,
  setDatabaseVolumePath,
  updateDatabaseMount,
} from "@/server/databases";

const volumePathFormSchema = z.object({
  volumePath: z
    .string()
    .min(1)
    .max(500)
    .regex(/^\/[\w.\-/]*$/, "must be an absolute path"),
});

const mountFormSchema = z.object({
  source: z
    .string()
    .min(1)
    .max(500)
    .regex(/^[\w.\-/:@]+$/, "not a valid mount source"),
  target: z
    .string()
    .min(1)
    .max(500)
    .regex(/^\/[\w.\-/]*$/, "must be an absolute path"),
  type: z.enum(["bind", "volume"]),
});

export function DatabaseVolumes({
  canEdit,
  databaseId,
  engine,
  extraMounts,
  swarmName,
  volumePath,
}: {
  canEdit: boolean;
  databaseId: string;
  engine: DatabaseEngine;
  extraMounts: DatabaseExtraMount[];
  swarmName: string;
  volumePath: string | null;
}) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const defaultPath = DEFAULT_DATABASE_VOLUME_PATH[engine];
  const resolvedPath = volumePath ?? defaultPath;

  const [addOpen, setAddOpen] = useState(false);
  const [editMount, setEditMount] = useState<DatabaseExtraMount | null>(null);
  const [primaryOpen, setPrimaryOpen] = useState(false);

  const invalidate = useCallback(async () => {
    await queryClient.invalidateQueries();
    await router.invalidate();
  }, [queryClient, router]);

  const remove = useMutation({
    mutationFn: (mountId: string) =>
      deleteDatabaseMount({ data: { databaseId, mountId } }),
    onSuccess: invalidate,
  });

  return (
    <Frame variant="ghost">
      <FrameHeader className="flex-row items-start justify-between gap-3">
        <div className="min-w-0">
          <FrameTitle>Volumes</FrameTitle>
          <FrameDescription>
            Mounts applied on the next provision. The primary volume is fixed to
            this database; only the path inside the container is editable.
          </FrameDescription>
        </div>
        {canEdit ? (
          <Button
            onClick={() => setAddOpen(true)}
            size="sm"
            type="button"
            variant="outline"
          >
            <PlusIcon data-icon="inline-start" />
            Add Volume
          </Button>
        ) : null}
      </FrameHeader>
      <FramePanel>
        <ul className="flex flex-col gap-3">
          <li className="flex items-start justify-between gap-3 rounded-xl border border-border px-4 py-3">
            <div className="grid min-w-0 gap-2 sm:grid-cols-3 sm:gap-4">
              <MountFact label="Mount Type" value="VOLUME" />
              <MountFact label="Volume Name" value={swarmName} />
              <MountFact label="Mount Path" value={resolvedPath} />
            </div>
            {canEdit ? (
              <Button
                aria-label="Edit primary volume path"
                onClick={() => setPrimaryOpen(true)}
                size="icon-sm"
                type="button"
                variant="ghost"
              >
                <PencilSimpleIcon />
              </Button>
            ) : null}
          </li>

          {extraMounts.map((mount) => (
            <li
              className="flex items-start justify-between gap-3 rounded-xl border border-border px-4 py-3"
              key={mount.id}
            >
              <div className="grid min-w-0 gap-2 sm:grid-cols-3 sm:gap-4">
                <MountFact
                  label="Mount Type"
                  value={mount.type.toUpperCase()}
                />
                <MountFact
                  label={mount.type === "bind" ? "Host Path" : "Volume Name"}
                  value={mount.source}
                />
                <MountFact label="Mount Path" value={mount.target} />
              </div>
              {canEdit ? (
                <div className="flex shrink-0 gap-1">
                  <Button
                    aria-label={`Edit mount ${mount.target}`}
                    onClick={() => setEditMount(mount)}
                    size="icon-sm"
                    type="button"
                    variant="ghost"
                  >
                    <PencilSimpleIcon />
                  </Button>
                  <Button
                    aria-label={`Delete mount ${mount.target}`}
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(mount.id)}
                    size="icon-sm"
                    type="button"
                    variant="ghost"
                  >
                    <TrashIcon />
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>

        {remove.isError ? (
          <p className="mt-3 text-destructive text-sm" role="alert">
            {errorMessage(remove.error, "could not delete mount")}
          </p>
        ) : null}
      </FramePanel>

      <PrimaryPathDialog
        databaseId={databaseId}
        defaultPath={defaultPath}
        onOpenChange={setPrimaryOpen}
        onSaved={invalidate}
        open={primaryOpen}
        volumePath={resolvedPath}
      />

      <MountDialog
        databaseId={databaseId}
        mount={null}
        onOpenChange={setAddOpen}
        onSaved={invalidate}
        open={addOpen}
        title="Add Volume"
      />

      <MountDialog
        databaseId={databaseId}
        mount={editMount}
        onOpenChange={(next) => {
          if (!next) {
            setEditMount(null);
          }
        }}
        onSaved={invalidate}
        open={editMount !== null}
        title="Edit Volume"
      />
    </Frame>
  );
}

function MountFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-muted-foreground text-xs">{label}</p>
      <p className="truncate font-mono text-sm">{value}</p>
    </div>
  );
}

function PrimaryPathDialog({
  databaseId,
  defaultPath,
  onOpenChange,
  onSaved,
  open,
  volumePath,
}: {
  databaseId: string;
  defaultPath: string;
  onOpenChange: (open: boolean) => void;
  onSaved: () => Promise<void>;
  open: boolean;
  volumePath: string;
}) {
  const save = useMutation({
    mutationFn: (path: string) =>
      setDatabaseVolumePath({
        data: {
          databaseId,
          volumePath: path === defaultPath ? null : path,
        },
      }),
    onSuccess: async () => {
      await onSaved();
      onOpenChange(false);
    },
  });

  const form = useAppForm({
    defaultValues: { volumePath },
    onSubmit: ({ value }) => save.mutateAsync(value.volumePath),
    validators: { onDynamic: volumePathFormSchema },
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when dialog opens
  useEffect(() => {
    if (open) {
      form.reset();
    }
  }, [form.reset, open, volumePath]);

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit primary mount path</DialogTitle>
          <DialogDescription>
            The volume name stays fixed. Only the path inside the container
            changes — needed when an image major bump moves the data directory.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <FieldGroup>
            <form.AppField name="volumePath">
              {(f) => (
                <f.FieldText
                  label="Mount Path"
                  placeholder={defaultPath}
                  required
                />
              )}
            </form.AppField>
          </FieldGroup>
          {save.isError ? (
            <p className="mt-3 text-destructive text-sm" role="alert">
              {errorMessage(save.error, "could not save")}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <DialogClose render={<Button variant="outline">Cancel</Button>} />
          <Button
            disabled={save.isPending}
            onClick={() => form.handleSubmit()}
            type="button"
          >
            {save.isPending ? <Spinner data-icon="inline-start" /> : null}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MountDialog({
  databaseId,
  mount,
  onOpenChange,
  onSaved,
  open,
  title,
}: {
  databaseId: string;
  mount: DatabaseExtraMount | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => Promise<void>;
  open: boolean;
  title: string;
}) {
  const save = useMutation({
    mutationFn: (value: z.infer<typeof mountFormSchema>) =>
      mount
        ? updateDatabaseMount({
            data: {
              databaseId,
              mountId: mount.id,
              source: value.source,
              target: value.target,
              type: value.type,
            },
          })
        : addDatabaseMount({
            data: {
              databaseId,
              source: value.source,
              target: value.target,
              type: value.type,
            },
          }),
    onSuccess: async () => {
      await onSaved();
      onOpenChange(false);
    },
  });

  const [type, setType] = useState<"bind" | "volume">(mount?.type ?? "volume");
  const [source, setSource] = useState(mount?.source ?? "");
  const [target, setTarget] = useState(mount?.target ?? "");
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setType(mount?.type ?? "volume");
      setSource(mount?.source ?? "");
      setTarget(mount?.target ?? "");
      setLocalError(null);
    }
  }, [mount, open]);

  const handleSave = () => {
    const parsed = mountFormSchema.safeParse({ source, target, type });
    if (!parsed.success) {
      setLocalError(parsed.error.issues[0]?.message ?? "invalid mount");
      return;
    }
    setLocalError(null);
    save.mutate(parsed.data);
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Extra mounts sit alongside the primary data volume. Do not target
            the engine data directory or /run/secrets.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <FieldGroup className="gap-4">
            <Field>
              <FieldLabel>Mount Type</FieldLabel>
              <Select
                onValueChange={(v) =>
                  setType((v as "bind" | "volume") ?? "volume")
                }
                value={type}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="volume">volume</SelectItem>
                    <SelectItem value="bind">bind</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel>
                {type === "bind" ? "Host Path" : "Volume Name"}
              </FieldLabel>
              <Input
                onChange={(e) => setSource(e.target.value)}
                placeholder={type === "bind" ? "/var/lib/extra" : "my-volume"}
                value={source}
              />
            </Field>
            <Field>
              <FieldLabel>Mount Path</FieldLabel>
              <Input
                onChange={(e) => setTarget(e.target.value)}
                placeholder="/mnt/extra"
                value={target}
              />
            </Field>
          </FieldGroup>
          {localError || save.isError ? (
            <p className="mt-3 text-destructive text-sm" role="alert">
              {localError ?? errorMessage(save.error, "could not save")}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <DialogClose render={<Button variant="outline">Cancel</Button>} />
          <Button disabled={save.isPending} onClick={handleSave} type="button">
            {save.isPending ? <Spinner data-icon="inline-start" /> : null}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
