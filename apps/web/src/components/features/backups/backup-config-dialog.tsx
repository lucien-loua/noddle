/**
 * biome-ignore-all lint/performance/noJsxPropsBind: dialog forms;
 * extracting every setState wrapper adds noise without shared children.
 */

import { BACKUP_CRON_PRESETS } from "@noddle/shared/validation/backup";
import { useEffect, useState } from "react";
import {
  DEFAULT_CRON,
  type ScheduleMode,
  scheduleModeFor,
} from "@/components/features/backup-shared/schedule";
import { useAppForm } from "@/components/fields/lib/form";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
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
import {
  type BackupConfigRow,
  createBackupConfig,
  type DestinationRow,
  updateBackupConfig,
} from "@/server/backups";
import { configFormDefaults } from "./config-form";

export function BackupConfigDialog({
  databaseId,
  defaultDatabaseName,
  destinations,

  editing,
  onOpenChange,
  onSaved,
  open,
}: {
  databaseId: string;
  defaultDatabaseName: string;
  destinations: DestinationRow[];

  editing: BackupConfigRow | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
  open: boolean;
}) {
  const [firstDestination] = destinations;
  const fallbackDestinationId = firstDestination ? firstDestination.id : "";
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
        const keepRaw = value.keepLatestCount.trim();
        const keepLatestCount =
          keepRaw === "" ? null : Number.parseInt(keepRaw, 10);
        if (keepLatestCount !== null && !Number.isFinite(keepLatestCount)) {
          throw new Error("Keep latest must be a number");
        }
        const payload = {
          databaseName: value.databaseName,
          destinationId: value.destinationId,
          enabled: value.enabled,
          keepLatestCount,
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
      } catch (err) {
        toast.add({
          description: errorMessage(err, "could not save schedule"),
          title: "Could not save schedule",
          type: "error",
        });
        throw err;
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

  if (!fallbackDestinationId) {
    return null;
  }

  const selectedDestination =
    destinations.find((d) => d.id === form.state.values.destinationId) ?? null;

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {editing ? "Edit schedule" : "Add schedule"}
          </DialogTitle>
          <DialogDescription>
            {editing
              ? "Changes apply to the next run. A dump already in flight keeps its original settings."
              : "How often Noddle should dump this database, and which destination receives the file."}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <form.AppForm>
            <FieldGroup>
              <Field>
                <FieldLabel>Destination</FieldLabel>
                <Combobox
                  items={destinations}
                  itemToStringLabel={(d: DestinationRow) => d.name}
                  itemToStringValue={(d: DestinationRow) => d.name}
                  onValueChange={(next) => {
                    if (!next) {
                      form.setFieldValue("destinationId", "");
                      return;
                    }
                    form.setFieldValue(
                      "destinationId",
                      (next as DestinationRow).id
                    );
                  }}
                  value={selectedDestination}
                >
                  <ComboboxInput placeholder="Choose a destination" />
                  <ComboboxContent>
                    <ComboboxEmpty>No destination matches.</ComboboxEmpty>
                    <ComboboxList>
                      {(d: DestinationRow) => (
                        <ComboboxItem key={d.id} value={d}>
                          {d.name}
                        </ComboboxItem>
                      )}
                    </ComboboxList>
                  </ComboboxContent>
                </Combobox>
              </Field>

              <form.AppField name="databaseName">
                {(f) => (
                  <f.FieldText
                    description="Name inside the engine that the dumper targets."
                    label="Database name"
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
                      When off, Noddle ignores this cadence until you turn it
                      back on. Manual runs still work.
                    </FieldDescription>
                  </Field>
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
      </DialogContent>
    </Dialog>
  );
}
