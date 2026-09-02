import { DEFAULT_DATABASE_VOLUME_PATH } from "@noddle/database-spec";
import type { DatabaseEngine } from "@noddle/database-spec";
import type { DatabaseExtraMount } from "@noddle/db/schema";
import { PencilSimpleIcon, PlusIcon, TrashIcon } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import type { SubmitEvent } from "react";
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
  DialogForm,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import {
  addDatabaseMount,
  deleteDatabaseMount,
  setDatabaseVolumePath,
  updateDatabaseMount,
} from "@/server/databases";

const volumePathFormSchema = z.object({
  volumePath: z
    .string()
    .min(1, "Enter a path.")
    .max(500, "Keep the path under 500 characters.")
    .regex(/^\/[\w.\-/]*$/, "must be an absolute path"),
});

const mountFormSchema = z.object({
  source: z
    .string()
    .min(1, "Enter the volume name or host path.")
    .max(500, "Keep the source under 500 characters.")
    .regex(/^[\w.\-/:@]+$/, "not a valid mount source"),
  target: z
    .string()
    .min(1, "Enter a path.")
    .max(500, "Keep the path under 500 characters.")
    .regex(/^\/[\w.\-/]*$/, "must be an absolute path"),
  type: z.enum(["bind", "volume"], "Choose a mount type."),
});

const MOUNT_TYPES = [
  { label: "Volume", value: "volume" },
  { label: "Bind", value: "bind" },
];

function selectMountType(state: { values: { type: string } }) {
  return state.values.type;
}

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
            <PlusIcon data-icon="inline-start" weight="regular" />
            Add volume
          </Button>
        ) : null}
      </FrameHeader>
      <FramePanel>
        <ul className="flex flex-col gap-3">
          <li className="flex items-start justify-between gap-3 rounded-xl border border-border px-4 py-3">
            <div className="grid min-w-0 gap-2 sm:grid-cols-3 sm:gap-4">
              <MountFact label="Mount type" value="Volume" />
              <MountFact label="Volume name" value={swarmName} />
              <MountFact label="Mount path" value={resolvedPath} />
            </div>
            {canEdit ? (
              <Button
                aria-label="Edit mount path"
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
                  label="Mount type"
                  value={mount.type === "bind" ? "Bind" : "Volume"}
                />
                <MountFact
                  label={mount.type === "bind" ? "Host path" : "Volume name"}
                  value={mount.source}
                />
                <MountFact label="Mount path" value={mount.target} />
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
        key={addOpen ? "add-open" : "add-closed"}
        mount={null}
        onOpenChange={setAddOpen}
        onSaved={invalidate}
        open={addOpen}
        title="Add volume"
      />

      <MountDialog
        databaseId={databaseId}
        key={
          editMount ? `${editMount.type}:${editMount.source}` : "edit-closed"
        }
        mount={editMount}
        onOpenChange={(next) => {
          if (!next) {
            setEditMount(null);
          }
        }}
        onSaved={invalidate}
        open={editMount !== null}
        title="Edit volume"
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

  useEffect(() => {
    if (open) {
      form.reset();
    }
  }, [form.reset, open, volumePath]);

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
          <DialogTitle>Edit mount path</DialogTitle>
          <DialogDescription>
            The volume name stays fixed. Only the path inside the container
            changes. Needed when an image major bump moves the data directory.
          </DialogDescription>
        </DialogHeader>
        <DialogForm onSubmit={handleSubmit}>
          <DialogBody>
            <FieldGroup>
              <form.AppField name="volumePath">
                {(f) => (
                  <f.FieldText
                    label="Mount path"
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
            <Button disabled={save.isPending} type="submit">
              {save.isPending ? <Spinner data-icon="inline-start" /> : null}
              Save
            </Button>
          </DialogFooter>
        </DialogForm>
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

  const form = useAppForm({
    defaultValues: {
      source: mount?.source ?? "",
      target: mount?.target ?? "",
      type: (mount?.type ?? "volume") as string,
    },
    onSubmit: ({ value }) => save.mutateAsync(mountFormSchema.parse(value)),
    validators: { onDynamic: mountFormSchema },
  });

  useEffect(() => {
    if (open) {
      form.reset();
    }
  }, [form.reset, open]);

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
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Extra mounts sit alongside the primary data volume. Do not target
            the engine data directory or /run/secrets.
          </DialogDescription>
        </DialogHeader>
        <DialogForm onSubmit={handleSubmit}>
          <DialogBody>
            <FieldGroup className="gap-4">
              <form.AppField name="type">
                {(f) => (
                  <f.FieldSelect label="Mount type" options={MOUNT_TYPES} />
                )}
              </form.AppField>
              <form.Subscribe selector={selectMountType}>
                {(mountType) => (
                  <form.AppField name="source">
                    {(f) => (
                      <f.FieldText
                        label={
                          mountType === "bind" ? "Host path" : "Volume name"
                        }
                        placeholder={
                          mountType === "bind" ? "/var/lib/extra" : "my-volume"
                        }
                        required
                      />
                    )}
                  </form.AppField>
                )}
              </form.Subscribe>
              <form.AppField name="target">
                {(f) => (
                  <f.FieldText
                    label="Mount path"
                    placeholder="/mnt/extra"
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
            <Button disabled={save.isPending} type="submit">
              {save.isPending ? <Spinner data-icon="inline-start" /> : null}
              Save
            </Button>
          </DialogFooter>
        </DialogForm>
      </DialogContent>
    </Dialog>
  );
}
