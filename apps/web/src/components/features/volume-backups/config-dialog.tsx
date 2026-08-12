/**
 * biome-ignore-all lint/performance/noJsxPropsBind: dialog forms;
 * extracting every setState wrapper adds noise without shared children.
 */

import { BACKUP_CRON_PRESETS } from "@noddle/shared/validation/backup";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_CRON,
  type ScheduleMode,
  scheduleModeFor,
} from "@/components/features/backups/schedule";
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
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { errorMessage } from "@/lib/format";
import { queries } from "@/lib/queries";
import type { DestinationRow } from "@/server/backups";
import {
  createVolumeBackupConfig,
  type ServiceVolumeRow,
  updateVolumeBackupConfig,
  type VolumeBackupConfigRow,
} from "@/server/volume-backups";
import {
  type VolumeBackupConfigFormValues,
  volumeBackupConfigFormSchema,
  volumeConfigFormDefaults,
  volumeConfigFormToPayload,
} from "./config-form";
import { ServiceVolumePicker } from "./service-volume-picker";

export function VolumeBackupConfigDialog({
  destinations,
  editing,
  onOpenChange,
  onSaved,
  open,
  serviceId,
}: {
  destinations: DestinationRow[];
  editing: VolumeBackupConfigRow | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
  open: boolean;
  serviceId: string;
}) {
  const [firstDestination] = destinations;
  const fallbackDestinationId = firstDestination ? firstDestination.id : "";
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

  const handleSubmit = useCallback(() => form.handleSubmit(), [form]);

  if (!fallbackDestinationId) {
    return null;
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {editing ? "Edit volume backup" : "Add volume backup"}
          </DialogTitle>
          <DialogDescription>
            {editing
              ? "Changes apply to the next run. A backup already in flight keeps its original settings."
              : "Tar a Docker volume on the service's server to S3 on a schedule."}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
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

            <Field>
              <FieldLabel>Schedule</FieldLabel>
              <Select
                onValueChange={(v) => {
                  const next = String(v) as ScheduleMode;
                  setScheduleMode(next);
                  if (next !== "custom") {
                    form.setFieldValue("schedule", next);
                  }
                }}
                value={scheduleMode}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Choose a cadence" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {BACKUP_CRON_PRESETS.map((p) => (
                      <SelectItem key={p.cron} value={p.cron}>
                        {p.label} ({p.cron})
                      </SelectItem>
                    ))}
                    <SelectItem value="custom">Custom cron</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
              {scheduleMode === "custom" ? (
                <form.AppField name="schedule">
                  {(f) => (
                    <f.FieldText
                      label="Cron expression"
                      placeholder={DEFAULT_CRON}
                      required
                    />
                  )}
                </form.AppField>
              ) : null}
              <FieldDescription>
                Five-field cron in UTC. The worker checks due schedules every
                few minutes.
              </FieldDescription>
            </Field>

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
                <Field>
                  <div className="flex items-center gap-2">
                    <Checkbox
                      checked={f.state.value}
                      onCheckedChange={(checked) =>
                        f.handleChange(checked === true)
                      }
                    />
                    <FieldLabel className="font-normal">
                      Run on schedule
                    </FieldLabel>
                  </div>
                  <FieldDescription>
                    When off, Noddle ignores this cadence until you turn it back
                    on. Manual runs still work.
                  </FieldDescription>
                </Field>
              )}
            </form.AppField>
          </FieldGroup>

          {save.isError ? (
            <p className="mt-3 text-destructive text-sm" role="alert">
              {errorMessage(save.error, "could not save schedule")}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Close</DialogClose>
          <Button disabled={save.isPending} onClick={handleSubmit}>
            {save.isPending ? <Spinner /> : null}
            {editing ? "Save changes" : "Add schedule"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
