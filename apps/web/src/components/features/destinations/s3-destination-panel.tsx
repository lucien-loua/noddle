import {
  ArchiveIcon,
  FolderIcon,
  GlobeIcon,
  KeyIcon,
  LinkIcon,
  TagIcon,
} from "@phosphor-icons/react";
import type { SubmitEvent } from "react";
import { useCallback, useEffect } from "react";

import {
  applyProvider,
  applyRegion,
  useS3DestinationForm,
} from "@/components/features/destinations/s3-destination-form";
import type { DestinationFormValues } from "@/components/features/destinations/s3-destination-form";
import { useResourceList } from "@/components/features/settings-list/hooks/use-resource-list";
import { useRowRemove } from "@/components/features/settings-list/hooks/use-row-remove";
import { useTestAndSave } from "@/components/features/settings-list/hooks/use-test-and-save";
import { SettingsList } from "@/components/features/settings-list/settings-list";
import { useAppForm } from "@/components/fields/lib/form";
import { IconStack } from "@/components/icon-stack";
import { ResourceCard, ResourceCardFact, ResourceCardMeta } from "@/components/resource-card";
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
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Frame, FrameDescription, FrameHeader, FrameTitle } from "@/components/ui/frame";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { roles } from "@/lib/permissions";
import type { RoleName } from "@/lib/permissions";
import { queries } from "@/lib/queries";
import { useCan } from "@/lib/use-permission";
import { deleteDestination, saveDestination, testDestination } from "@/server/backups/destinations";
import type { DestinationRow } from "@/server/backups/destinations";

interface Props {
  destinations: DestinationRow[];
  editing: DestinationRow | null;
  onEdit: (row: DestinationRow | null) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  role: string | null;
}

export function S3DestinationPanel({
  destinations: initial,
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
  const { data: destinations, isEmpty, refresh } = useResourceList(queries.destinations, initial);

  const handleCreate = useCallback(() => {
    onEdit(null);
    onOpenChange(true);
  }, [onEdit, onOpenChange]);

  const handleEdit = useCallback(
    (row: DestinationRow) => {
      onEdit(row);
      onOpenChange(true);
    },
    [onEdit, onOpenChange],
  );

  return (
    <>
      <DestinationDialog
        canEdit={canEdit}
        initial={editing}
        key={editing ? editing.id : "new"}
        onOpenChange={onOpenChange}
        onSaved={refresh}
        open={open}
      />

      <SettingsList isEmpty={isEmpty}>
        <SettingsList.Empty>
          <SettingsList.EmptyMedia>
            <IconStack>
              <ArchiveIcon className="size-5" />
            </IconStack>
          </SettingsList.EmptyMedia>
          <SettingsList.EmptyHeader>
            <SettingsList.EmptyTitle>No S3 destination</SettingsList.EmptyTitle>
            <SettingsList.EmptyDescription>
              Databases cannot be backed up until Noddle has somewhere to push the dumps. Any
              S3-compatible store works.
            </SettingsList.EmptyDescription>
          </SettingsList.EmptyHeader>
          {canEdit ? (
            <SettingsList.EmptyContent>
              <Button onClick={handleCreate}>Add a destination</Button>
            </SettingsList.EmptyContent>
          ) : null}
        </SettingsList.Empty>

        <Frame className="w-full" variant="ghost">
          <FrameHeader>
            <FrameTitle>S3 destinations</FrameTitle>
            <FrameDescription>
              Where Noddle pushes database dumps. One is enough for most installations — a picker
              only shows up once there are two.
            </FrameDescription>
          </FrameHeader>
          {destinations.map((row) => (
            <DestinationLine
              canEdit={canEdit}
              key={row.id}
              onEdit={handleEdit}
              onRemoved={refresh}
              row={row}
            />
          ))}
        </Frame>
      </SettingsList>
    </>
  );
}

function DestinationLine({
  canEdit,
  onEdit,
  onRemoved,
  row,
}: {
  canEdit: boolean;
  onEdit: (row: DestinationRow) => void;
  onRemoved: () => void;
  row: DestinationRow;
}) {
  const { error, handleRemove, isPending } = useRowRemove({
    errorFallback: "could not be removed",
    mutationFn: () => deleteDestination({ data: { id: row.id } }),
    onRemoved: () => {
      toast.add({ title: `${row.name} removed`, type: "success" });
      onRemoved();
    },
  });

  const handleEdit = useCallback(() => onEdit(row), [onEdit, row]);

  return (
    <ResourceCard
      actions={
        canEdit ? (
          <>
            <Button onClick={handleEdit} size="sm" variant="outline">
              Edit
            </Button>
            <Button disabled={isPending} onClick={handleRemove} size="sm" variant="ghost">
              {isPending ? <Spinner data-icon="inline-start" /> : null}
              Remove
            </Button>
          </>
        ) : null
      }
      title={<h2 className="truncate font-semibold text-sm">{row.name}</h2>}
    >
      <ResourceCardMeta>
        <ResourceCardFact label="Bucket" value={row.bucket} />
        <ResourceCardFact label="Endpoint" value={row.endpoint} />
        <ResourceCardFact label="Region" value={row.region} />
        <ResourceCardFact label="Prefix" value={row.prefix || "—"} />
      </ResourceCardMeta>
      {error ? (
        <p className="mt-2 text-destructive text-xs" role="status">
          {error}
        </p>
      ) : null}
    </ResourceCard>
  );
}

function DestinationDialog({
  canEdit,
  initial,
  onOpenChange,
  onSaved,
  open,
}: {
  canEdit: boolean;
  initial: DestinationRow | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void | Promise<void>;
  open: boolean;
}) {
  const {
    defaultValues,
    endpointPlaceholder,
    formSchema,
    providerSelectOptions,
    selectProviderRegion,
    toPayload,
  } = useS3DestinationForm(initial);

  const { busy, runSave, runTest, savePending, testPending } = useTestAndSave({
    onSaved: async () => {
      onOpenChange(false);
      await onSaved();
    },
    saveError: { fallback: "destination rejected", title: "Not saved" },
    saveFn: (value: DestinationFormValues) => saveDestination({ data: toPayload(value) }),
    saveSuccess: (value) => ({
      description: "Tested, then saved.",
      title: initial ? `${value.name} updated` : `${value.name} added`,
    }),
    testError: {
      fallback: "the bucket refused the credentials",
      title: "Cannot reach the destination",
    },
    testFn: (value: DestinationFormValues) => testDestination({ data: toPayload(value) }),
    testSuccess: () => ({
      description: "Write, read and delete all verified against the bucket.",
      title: "Destination reachable",
    }),
  });

  const form = useAppForm({
    defaultValues,
    onSubmit: ({ meta, value }) => (meta.intent === "test" ? runTest(value) : runSave(value)),
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
    [form],
  );
  const handleTest = useCallback(() => {
    form.handleSubmit({ intent: "test" });
  }, [form]);

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{initial ? `Edit ${initial.name}` : "Add an S3 destination"}</DialogTitle>
          <DialogDescription>
            Saving tests it first — a write, a read and a delete against the bucket.
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
                    {(f) => <f.FieldSelect label="Provider" options={providerSelectOptions} />}
                  </form.AppField>

                  <form.Subscribe selector={selectProviderRegion}>
                    {({ providerId, region }) => (
                      <form.AppField name="endpoint">
                        {(f) => (
                          <f.FieldText
                            addonStart={<LinkIcon />}
                            label="Endpoint"
                            placeholder={endpointPlaceholder(providerId, region)}
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
                        applyRegion(value ?? "", form.state.values.providerId, form.setFieldValue);
                      },
                    }}
                    name="region"
                  >
                    {(f) => <f.FieldText addonStart={<GlobeIcon />} label="Region" required />}
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
                  Encrypted at rest and never sent back to the browser. Noddle&apos;s own servers
                  push the dumps, so these never travel to a target machine.
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
                        description={initial ? "Leave empty to keep the stored key." : undefined}
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
                        onCheckedChange={(checked) => field.handleChange(checked === true)}
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
                <Button disabled={busy} onClick={handleTest} type="button" variant="outline">
                  {testPending ? <Spinner /> : null}
                  Test connection
                </Button>
                <Button disabled={busy} type="submit">
                  {savePending ? <Spinner /> : null}
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
