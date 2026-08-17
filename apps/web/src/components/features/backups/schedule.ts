import { BACKUP_CRON_PRESETS } from "@noddle/shared/validation/backup";

export const DEFAULT_CRON = "0 0 * * *";

export type ScheduleMode = (typeof BACKUP_CRON_PRESETS)[number]["cron"] | "custom";

export function isPresetCron(value: string): value is Exclude<ScheduleMode, "custom"> {
  return BACKUP_CRON_PRESETS.some((p) => p.cron === value);
}

export function scheduleModeFor(schedule: string): ScheduleMode {
  return isPresetCron(schedule) ? schedule : "custom";
}
