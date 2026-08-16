/**
 * biome-ignore-all lint/performance/noJsxPropsBind: dialog forms;
 * extracting every setState wrapper adds noise without shared children.
 */

import { useMutation, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";

import { copyFor } from "@/components/features/backups/copy";
import { DEFAULT_CRON, scheduleModeFor } from '@/components/features/backups/schedule';
import type { ScheduleMode } from '@/components/features/backups/schedule';
import { ScheduleCadence } from "@/components/features/backups/schedule-cadence";
import { ServiceVolumePicker } from "@/components/features/backups/service-volume-picker";
import { useAppForm } from "@/components/fields/lib/form";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import type { BackupSubject } from "@/lib/backup-subject";
import { errorMessage } from "@/lib/format";
import { queries } from "@/lib/queries";
import { createBackupConfig, updateBackupConfig } from '@/server/backups/configs';
import type { BackupConfigRow } from '@/server/backups/configs';
import type { DestinationRow } from "@/server/backups/destinations";
import { createVolumeBackupConfig, updateVolumeBackupConfig } from '@/server/backups/volume/configs';
import type { VolumeBackupConfigRow } from '@/server/backups/volume/configs';
import type { ServiceVolumeRow } from "@/server/backups/volume/volumes";

import { configFormDefaults, parseKeepLatestCount, volumeBackupConfigFormSchema, volumeConfigFormDefaults, volumeConfigFormToPayload } from './config-form';
import type { VolumeBackupConfigFormValues } from './config-form';

function EnabledField({
  checked,
  onCheckedChange,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <Field>
      <div className="flex items-center gap-2">
        <Checkbox
          checked={checked}
          onCheckedChange={(value) => onCheckedChange(value === true)}
        />
        <FieldLabel className="font-normal">Run on schedule</FieldLabel>
      </div>
      <FieldDescription>
        When off, Noddle ignores this cadence until you turn it back on. Manual
        runs still work.
      </FieldDescription>
    </Field>
  );
}

function DatabaseScheduleForm({
  databaseId,
  defaultDatabaseName,
  destinations,
  editing,
  fallbackDestinationId,
  onSaved,
  open,
}: {
  databaseId: string;
  defaultDatabaseName: string;
  destinations: DestinationRow[];
  editing: BackupConfigRow | null;
  fallbackDestinationId: string;
  onSaved: () => void;
  open: boolean;
}) {
  const copy = copyFor("database");
  const defaults = configFormDefaults(
    editing,
    defaultDatabaseName,
    fallbackDestinationId
  );
  const [scheduleMode, setScheduleMode] = useState<ScheduleMode>(
    scheduleModeFor(defaults.schedule)
  );

  const form = useAppForm({
    defaultValues: defaults,
    onSubmit: async ({ value }) => {
      try {
        const payload = {
          databaseName: value.databaseName,
          destinationId: value.destinationId,
          enabled: value.enabled,
          keepLatestCount: parseKeepLatestCount(value.keepLatestCount),
          prefix: value.prefix,
          schedule: value.schedule.trim(),
        };
        if (editing) {
          await updateBackupConfig({
            data: { ...payload, configId: editing.id },
          });
        } else {
          await createBackupConfig({
            data: { ...payload, databaseId },
          });
        }
        toast.add({
          title: editing ? "Schedule updated" : "Schedule added",
          type: "success",
        });
        onSaved();
      } catch (error) {
        toast.add({
          description: errorMessage(error, "could not save schedule"),
          title: "Could not save schedule",
          type: "error",
        });
        throw error;
      }
    },
  });

  useEffect(() => {
    if (!open) {
      return;
    }
    form.reset();
    setScheduleMode(scheduleModeFor(defaults.schedule));
  }, [open, form.reset, defaults.schedule]);

  const handleModeChange = (next: ScheduleMode) => {
    setScheduleMode(next);
    if (next !== "custom") {
      form.setFieldValue("schedule", next);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {editing ? copy.dialogTitleEdit : copy.dialogTitleNew}
        </DialogTitle>
        <DialogDescription>
          {editing ? copy.dialogDescriptionEdit : copy.dialogDescriptionNew}
        </DialogDescription>
      </DialogHeader>
      <DialogBody>
        <form.AppForm>
          <FieldGroup>
            <form.AppField name="destinationId">
              {(f) => (
                <f.FieldCombobox
                  emptyText="No destination matches."
                  items={destinations}
                  itemToId={(d: DestinationRow) => d.id}
                  itemToStringLabel={(d: DestinationRow) => d.name}
                  itemToStringValue={(d: DestinationRow) => d.name}
                  label="Destination"
                  placeholder="Choose a destination"
                  renderItem={(d: DestinationRow) => d.name}
                  required
                />
              )}
            </form.AppField>

            <form.AppField name="databaseName">
              {(f) => (
                <f.FieldText
                  description="Name inside the engine that the dumper targets."
                  label="Database name"
                />
              )}
            </form.AppField>

            <ScheduleCadence
              onModeChange={handleModeChange}
              scheduleMode={scheduleMode}
            >
              <form.AppField name="schedule">
                {(f) => (
                  <f.FieldText
                    label="Cron expression"
                    placeholder={DEFAULT_CRON}
                  />
                )}
              </form.AppField>
            </ScheduleCadence>

            <form.AppField name="prefix">
              {(f) => (
                <f.FieldText
                  description="Appended under the destination prefix in the bucket. Leave empty to use the destination alone."
                  label="Object prefix"
                />
              )}
            </form.AppField>

            <form.AppField name="keepLatestCount">
              {(f) => (
                <f.FieldText
                  description="Leave empty to keep every dump. A number prunes older ones after each successful run."
                  label="Retention"
                  placeholder="Keep all"
                />
              )}
            </form.AppField>

            <form.AppField name="enabled">
              {(f) => (
                <EnabledField
                  checked={f.state.value}
                  onCheckedChange={(checked) => f.handleChange(checked)}
                />
              )}
            </form.AppField>
          </FieldGroup>
        </form.AppForm>
      </DialogBody>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" />}>Close</DialogClose>
        <Button
          disabled={form.state.isSubmitting}
          onClick={() => form.handleSubmit()}
        >
          {form.state.isSubmitting ? <Spinner /> : null}
          {editing ? "Save changes" : "Add schedule"}
        </Button>
      </DialogFooter>
    </>
  );
}

function VolumeScheduleForm({
  destinations,
  editing,
  fallbackDestinationId,
  onSaved,
  open,
  serviceId,
}: {
  destinations: DestinationRow[];
  editing: VolumeBackupConfigRow | null;
  fallbackDestinationId: string;
  onSaved: () => void;
  open: boolean;
  serviceId: string;
}) {
  const copy = copyFor("volume");
  const defaults = volumeConfigFormDefaults(editing, fallbackDestinationId);
  const [scheduleMode, setScheduleMode] = useState<ScheduleMode>(
    scheduleModeFor(defaults.schedule)
  );
  const volumesQuery = useQuery({
    ...queries.serviceVolumes(serviceId),
    enabled: open,
  });
  const serviceVolumes = volumesQuery.data ?? [];

  const save = useMutation({
    mutationFn: async (value: VolumeBackupConfigFormValues) => {
      const payload = volumeConfigFormToPayload(value);
      if (editing) {
        await updateVolumeBackupConfig({
          data: { ...payload, configId: editing.id },
        });
        return;
      }
      await createVolumeBackupConfig({
        data: { ...payload, serviceId },
      });
    },
    onSuccess: () => {
      toast.add({
        title: editing ? "Schedule updated" : "Schedule added",
        type: "success",
      });
      onSaved();
    },
  });

  const form = useAppForm({
    defaultValues: defaults,
    onSubmit: ({ value }) => save.mutateAsync(value),
    validators: { onDynamic: volumeBackupConfigFormSchema },
  });

  useEffect(() => {
    if (!open) {
      return;
    }
    form.reset();
    setScheduleMode(scheduleModeFor(defaults.schedule));
  }, [open, form.reset, defaults.schedule]);

  const handleVolumePick = useCallback(
    (volume: ServiceVolumeRow) => {
      form.setFieldValue("volumeName", volume.volumeName);
      form.setFieldValue("mountPath", volume.mountPath);
    },
    [form.setFieldValue]
  );

  const handleModeChange = (next: ScheduleMode) => {
    setScheduleMode(next);
    if (next !== "custom") {
      form.setFieldValue("schedule", next);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {editing ? copy.dialogTitleEdit : copy.dialogTitleNew}
        </DialogTitle>
        <DialogDescription>
          {editing ? copy.dialogDescriptionEdit : copy.dialogDescriptionNew}
        </DialogDescription>
      </DialogHeader>
      <DialogBody>
        <form.AppForm>
          <FieldGroup>
            <form.AppField name="destinationId">
              {(f) => (
                <f.FieldCombobox
                  emptyText="No destination matches."
                  items={destinations}
                  itemToId={(d: DestinationRow) => d.id}
                  itemToStringLabel={(d: DestinationRow) => d.name}
                  itemToStringValue={(d: DestinationRow) => d.name}
                  label="Destination"
                  placeholder="Choose a destination"
                  renderItem={(d: DestinationRow) => d.name}
                  required
                />
              )}
            </form.AppField>

            <ServiceVolumePicker
              enabled={open}
              error={volumesQuery.error}
              isError={volumesQuery.isError}
              isLoading={volumesQuery.isLoading}
              onPick={handleVolumePick}
              volumes={serviceVolumes}
            />

            <form.AppField
              listeners={{
                onChange: ({ value }) => {
                  const volume = serviceVolumes.find(
                    (v: ServiceVolumeRow) => v.volumeName === value
                  );
                  form.setFieldValue("mountPath", volume?.mountPath ?? "");
                },
              }}
              name="volumeName"
            >
              {(f) => (
                <f.FieldText
                  description="The name of the Docker volume to backup."
                  label="Volume name"
                  placeholder="hello-data-abc123"
                  required
                />
              )}
            </form.AppField>

            <ScheduleCadence
              onModeChange={handleModeChange}
              scheduleMode={scheduleMode}
            >
              <form.AppField name="schedule">
                {(f) => (
                  <f.FieldText
                    label="Cron expression"
                    placeholder={DEFAULT_CRON}
                    required
                  />
                )}
              </form.AppField>
            </ScheduleCadence>

            <form.AppField name="prefix">
              {(f) => (
                <f.FieldText
                  description="Appended under the destination prefix in the bucket."
                  label="Object prefix"
                />
              )}
            </form.AppField>

            <form.AppField name="keepLatestCount">
              {(f) => (
                <f.FieldText
                  description="Leave empty to keep every backup. A number prunes older ones after each successful run."
                  label="Retention"
                  placeholder="Keep all"
                />
              )}
            </form.AppField>

            <form.AppField name="enabled">
              {(f) => (
                <EnabledField
                  checked={f.state.value}
                  onCheckedChange={(checked) => f.handleChange(checked)}
                />
              )}
            </form.AppField>
          </FieldGroup>
        </form.AppForm>

        {save.isError ? (
          <p className="mt-3 text-destructive text-sm" role="alert">
            {errorMessage(save.error, "could not save schedule")}
          </p>
        ) : null}
      </DialogBody>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" />}>Close</DialogClose>
        <Button disabled={save.isPending} onClick={() => form.handleSubmit()}>
          {save.isPending ? <Spinner /> : null}
          {editing ? "Save changes" : "Add schedule"}
        </Button>
      </DialogFooter>
    </>
  );
}

interface DatabaseConfigDialogProps {
  defaultDatabaseName: string;
  destinations: DestinationRow[];
  editing: BackupConfigRow | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
  open: boolean;
  subject: Extract<BackupSubject, { kind: "database" }>;
}

interface VolumeConfigDialogProps {
  destinations: DestinationRow[];
  editing: VolumeBackupConfigRow | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
  open: boolean;
  subject: Extract<BackupSubject, { kind: "volume" }>;
}

type BackupConfigDialogProps =
  | DatabaseConfigDialogProps
  | VolumeConfigDialogProps;

function isDatabaseConfig(
  props: BackupConfigDialogProps
): props is DatabaseConfigDialogProps {
  return props.subject.kind === "database";
}

export function BackupConfigDialog(props: BackupConfigDialogProps) {
  const [firstDestination] = props.destinations;
  const fallbackDestinationId = firstDestination ? firstDestination.id : "";

  if (!fallbackDestinationId) {
    return null;
  }

  if (isDatabaseConfig(props)) {
    return (
      <Dialog onOpenChange={props.onOpenChange} open={props.open}>
        <DialogContent className="sm:max-w-lg">
          <DatabaseScheduleForm
            databaseId={props.subject.databaseId}
            defaultDatabaseName={props.defaultDatabaseName}
            destinations={props.destinations}
            editing={props.editing}
            fallbackDestinationId={fallbackDestinationId}
            onSaved={props.onSaved}
            open={props.open}
          />
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog onOpenChange={props.onOpenChange} open={props.open}>
      <DialogContent className="sm:max-w-lg">
        <VolumeScheduleForm
          destinations={props.destinations}
          editing={props.editing}
          fallbackDestinationId={fallbackDestinationId}
          onSaved={props.onSaved}
          open={props.open}
          serviceId={props.subject.serviceId}
        />
      </DialogContent>
    </Dialog>
  );
}
