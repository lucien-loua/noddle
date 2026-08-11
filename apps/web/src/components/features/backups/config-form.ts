import type { BackupConfigRow } from "@/server/backups";
import { DEFAULT_CRON } from "./schedule";

export function configFormDefaults(
  editing: BackupConfigRow | null,
  defaultDatabaseName: string,
  fallbackDestinationId: string
) {
  if (editing) {
    return {
      databaseName: editing.databaseName,
      destinationId: editing.destinationId,
      enabled: editing.enabled,
      keepLatestCount:
        editing.keepLatestCount === null ? "" : String(editing.keepLatestCount),
      prefix: editing.prefix,
      schedule: editing.schedule,
    };
  }
  return {
    databaseName: defaultDatabaseName,
    destinationId: fallbackDestinationId,
    enabled: true,
    keepLatestCount: "",
    prefix: "",
    schedule: DEFAULT_CRON,
  };
}
