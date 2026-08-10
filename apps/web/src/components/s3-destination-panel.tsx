import {
  ArchiveIcon,
  FolderIcon,
  GlobeIcon,
  KeyIcon,
  LinkIcon,
  TagIcon,
} from "@phosphor-icons/react";
import { useMutation } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import type { SubmitEvent } from "react";
import { useCallback, useEffect, useState } from "react";
import { useAppForm } from "@/components/fields/lib/form";
import { IconStack } from "@/components/icon-stack";
import {
  applyProvider,
  applyRegion,
  type DestinationFormValues,
  useS3DestinationForm,
} from "@/components/s3-destination-form";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
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
import { toast } from "@/components/ui/toast";
import { errorMessage } from "@/lib/format";
import { type RoleName, roles } from "@/lib/permissions";
import { useCan } from "@/lib/use-permission";
import {
  type DestinationRow,
  deleteDestination,
  saveDestination,
  testDestination,
} from "@/server/backups";

interface Props {
  destinations: DestinationRow[];
  editing: DestinationRow | null;
  onEdit: (row: DestinationRow | null) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  role: string | null;
}

export function S3DestinationPanel({
  destinations,
  editing,
  onEdit,
  onOpenChange,
  open,
  role,
}: Props) {
  const known = role && role in roles ? (role as RoleName) : null;
  // `backup:create` — the same permission as triggering a manual backup.
  // A destination is configuration, not a secret to hide: reading stays
  // open, only writing is guarded.
  const canEdit = useCan(known, "backup", "create");

  const handleCreate = useCallback(() => {
    onEdit(null);
    onOpenChange(true);
  }, [onEdit, onOpenChange]);

  const handleEdit = useCallback(
    (row: DestinationRow) => {
      onEdit(row);
      onOpenChange(true);
    },
    [onEdit, onOpenChange]
  );

  if (destinations.length === 0) {
    return (
      <>
        <DestinationDialog
          canEdit={canEdit}
          initial={null}
          onOpenChange={onOpenChange}
          open={open}
        />
        <Empty className="h-full">
          <EmptyMedia>
            <IconStack>
              <ArchiveIcon className="size-5" weight="duotone" />
            </IconStack>
          </EmptyMedia>
          <EmptyHeader>
            <EmptyTitle>No S3 destination</EmptyTitle>
            <EmptyDescription>
              Databases cannot be backed up until Noddle has somewhere to push
              the dumps. Any S3-compatible store works.
            </EmptyDescription>
          </EmptyHeader>
          {canEdit ? (
            <EmptyContent>
              <Button onClick={handleCreate}>Add a destination</Button>
            </EmptyContent>
          ) : null}
        </Empty>
      </>
    );
  }

  return (
    <>
      <DestinationDialog
        canEdit={canEdit}
        initial={editing}
        key={editing ? editing.id : "new"}
        onOpenChange={onOpenChange}
        open={open}
      />

      <Frame variant="ghost">
        <FrameHeader>
          <FrameTitle>S3 destinations</FrameTitle>
          <FrameDescription>
            Where Noddle pushes database dumps. One is enough for most
            installations — a picker only shows up once there are two.
          </FrameDescription>
        </FrameHeader>
        <FramePanel className="p-0">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Name</TableHead>
                <TableHead>Location</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {destinations.map((row) => (
                <DestinationLine
                  canEdit={canEdit}
                  key={row.id}
                  onEdit={handleEdit}
                  row={row}
                />
              ))}
            </TableBody>
          </Table>
        </FramePanel>
      </Frame>
    </>
  );
}

function DestinationLine({
  canEdit,
  onEdit,
  row,
}: {
  canEdit: boolean;
  onEdit: (row: DestinationRow) => void;
  row: DestinationRow;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  const remove = useMutation({
    mutationFn: () => deleteDestination({ data: { id: row.id } }),
    onError: (e: Error) => setError(errorMessage(e, "could not be removed")),
    onSuccess: async () => {
      toast.add({ title: `${row.name} removed`, type: "success" });
      await router.invalidate();
    },
  });

  const handleEdit = useCallback(() => onEdit(row), [onEdit, row]);
  const handleRemove = useCallback(() => {
    setError(null);
    remove.mutate();
  }, [remove]);

  return (
    <TableRow>
      <TableCell className="font-medium">{row.name}</TableCell>
      <TableCell className="text-muted-foreground text-sm">
        {row.bucket} · {row.endpoint} · {row.region}
        {row.prefix ? ` · ${row.prefix}` : ""}
        {error ? (
          <span className="block text-destructive text-xs" role="status">
            {error}
          </span>
        ) : null}
      </TableCell>
      <TableCell className="text-end">
        {canEdit ? (
          <div className="flex justify-end gap-1">
            <Button onClick={handleEdit} size="sm" variant="outline">
              Edit
            </Button>
            <Button
              disabled={remove.isPending}
              onClick={handleRemove}
              size="sm"
              variant="ghost"
            >
              {remove.isPending ? <Spinner /> : null}
              Remove
            </Button>
          </div>
        ) : null}
      </TableCell>
    </TableRow>
  );
}

function DestinationDialog({
  canEdit,
  initial,
  onOpenChange,
  open,
}: {
  canEdit: boolean;
  initial: DestinationRow | null;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const router = useRouter();
  const {
    defaultValues,
    endpointPlaceholder,
    formSchema,
    providerSelectOptions,
    selectProviderRegion,
    toPayload,
  } = useS3DestinationForm(initial);

  const test = useMutation({
    mutationFn: (value: DestinationFormValues) =>
      testDestination({ data: toPayload(value) }),
    onError: (e: Error) =>
      toast.add({
        description: errorMessage(e, "the bucket refused the credentials"),
        title: "Cannot reach the destination",
        type: "error",
      }),
    onSuccess: () =>
      toast.add({
        description: "Write, read and delete all verified against the bucket.",
        title: "Destination reachable",
        type: "success",
      }),
  });

  const save = useMutation({
    mutationFn: (value: DestinationFormValues) =>
      saveDestination({ data: toPayload(value) }),
    onError: (e: Error) =>
      toast.add({
        description: errorMessage(e, "destination rejected"),
        title: "Not saved",
        type: "error",
      }),
    onSuccess: async (_result, value) => {
      toast.add({
        description: "Tested, then saved.",
        title: initial ? `${value.name} updated` : `${value.name} added`,
        type: "success",
      });
      onOpenChange(false);
      await router.invalidate();
    },
  });

  const form = useAppForm({
    defaultValues,
    onSubmit: ({ meta, value }) =>
      meta.intent === "test"
        ? test.mutateAsync(value)
        : save.mutateAsync(value),
    onSubmitMeta: { intent: "save" } as { intent: "save" | "test" },
    validators: { onDynamic: formSchema },
  });

  useEffect(() => {
    if (open) {
      form.reset();
    }
  }, [open, form.reset]);

  const handleSubmit = useCallback(
    (event: SubmitEvent) => {
      event.preventDefault();
      form.handleSubmit({ intent: "save" });
    },
    [form]
  );
  const handleTest = useCallback(() => {
    form.handleSubmit({ intent: "test" });
  }, [form]);

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {initial ? `Edit ${initial.name}` : "Add an S3 destination"}
          </DialogTitle>
          <DialogDescription>
            Saving tests it first — a write, a read and a delete against the
            bucket.
          </DialogDescription>
        </DialogHeader>

        <DialogForm onSubmit={handleSubmit}>
          <DialogBody>
            <FieldGroup>
              <FieldSet disabled={!canEdit}>
                <FieldLegend variant="label">Location</FieldLegend>
                <div className="grid gap-x-4 gap-y-4 sm:grid-cols-2">
                  <form.AppField name="name">
                    {(f) => (
                      <f.FieldText
                        addonStart={<TagIcon />}
                        label="Name"
                        placeholder="Backblaze EU"
                        required
                      />
                    )}
                  </form.AppField>

                  <form.AppField
                    listeners={{
                      onChange: ({ value }) => {
                        applyProvider(value, form.setFieldValue);
                      },
                    }}
                    name="providerId"
                  >
                    {(f) => (
                      <f.FieldSelect
                        label="Provider"
                        options={providerSelectOptions}
                      />
                    )}
                  </form.AppField>

                  <form.Subscribe selector={selectProviderRegion}>
                    {({ providerId, region }) => (
                      <form.AppField name="endpoint">
                        {(f) => (
                          <f.FieldText
                            addonStart={<LinkIcon />}
                            label="Endpoint"
                            placeholder={endpointPlaceholder(
                              providerId,
                              region
                            )}
                            required
                          />
                        )}
                      </form.AppField>
                    )}
                  </form.Subscribe>

                  <form.AppField name="bucket">
                    {(f) => (
                      <f.FieldText
                        addonStart={<ArchiveIcon />}
                        label="Bucket"
                        placeholder="noddle-backups"
                        required
                      />
                    )}
                  </form.AppField>

                  <form.AppField
                    listeners={{
                      onChange: ({ value }) => {
                        applyRegion(
                          value ?? "",
                          form.state.values.providerId,
                          form.setFieldValue
                        );
                      },
                    }}
                    name="region"
                  >
                    {(f) => (
                      <f.FieldText
                        addonStart={<GlobeIcon />}
                        label="Region"
                        required
                      />
                    )}
                  </form.AppField>

                  <form.AppField name="prefix">
                    {(f) => (
                      <f.FieldText
                        addonStart={<FolderIcon />}
                        label="Prefix (optional)"
                        placeholder="backups"
                      />
                    )}
                  </form.AppField>
                </div>
              </FieldSet>

              <FieldSet disabled={!canEdit}>
                <FieldLegend variant="label">Credentials</FieldLegend>
                <FieldDescription>
                  Encrypted at rest and never sent back to the browser.
                  Noddle&apos;s own servers push the dumps, so these never
                  travel to a target machine.
                </FieldDescription>
                <div className="grid gap-x-4 gap-y-4 sm:grid-cols-2">
                  <form.AppField name="accessKeyId">
                    {(f) => (
                      <f.FieldText
                        addonStart={<KeyIcon />}
                        autoComplete="off"
                        label="Access key ID"
                        required
                      />
                    )}
                  </form.AppField>

                  <form.AppField name="secretAccessKey">
                    {(f) => (
                      <f.FieldText
                        addonStart={<KeyIcon />}
                        autoComplete="new-password"
                        description={
                          initial
                            ? "Leave empty to keep the stored key."
                            : undefined
                        }
                        label="Secret access key"
                        placeholder={initial ? "unchanged" : ""}
                        required={!initial}
                        type="password"
                      />
                    )}
                  </form.AppField>
                </div>

                <form.AppField name="forcePathStyle">
                  {(field) => (
                    <Field orientation="horizontal">
                      <Checkbox
                        checked={field.state.value}
                        id="pathStyle"
                        // biome-ignore lint/performance/noJsxPropsBind: adapts onCheckedChange to the field
                        onCheckedChange={(checked) =>
                          field.handleChange(checked === true)
                        }
                      />
                      <FieldLabel className="font-normal" htmlFor="pathStyle">
                        Path-style addressing (required outside Amazon S3)
                      </FieldLabel>
                    </Field>
                  )}
                </form.AppField>
              </FieldSet>
            </FieldGroup>
          </DialogBody>

          <DialogFooter>
            <DialogClose
              render={
                <Button type="button" variant="outline">
                  Cancel
                </Button>
              }
            />
            {canEdit ? (
              <>
                <Button
                  disabled={test.isPending || save.isPending}
                  onClick={handleTest}
                  type="button"
                  variant="outline"
                >
                  {test.isPending ? <Spinner /> : null}
                  Test connection
                </Button>
                <Button
                  disabled={save.isPending || test.isPending}
                  type="submit"
                >
                  {save.isPending ? <Spinner /> : null}
                  Save
                </Button>
              </>
            ) : null}
          </DialogFooter>
        </DialogForm>
      </DialogContent>
    </Dialog>
  );
}
