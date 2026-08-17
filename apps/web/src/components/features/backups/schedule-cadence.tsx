import { BACKUP_CRON_PRESETS } from "@noddle/shared/validation/backup";
import type { ReactNode } from "react";

import type { ScheduleMode } from "@/components/features/backups/schedule";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function ScheduleCadence({
  children,
  onModeChange,
  scheduleMode,
}: {
  children: ReactNode;
  onModeChange: (mode: ScheduleMode) => void;
  scheduleMode: ScheduleMode;
}) {
  return (
    <Field>
      <FieldLabel>Schedule</FieldLabel>
      <Select
        onValueChange={(v) => onModeChange(v as ScheduleMode)}
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
      {scheduleMode === "custom" ? children : null}
      <FieldDescription>
        Five-field cron in UTC. The worker checks due schedules every few
        minutes.
      </FieldDescription>
    </Field>
  );
}
