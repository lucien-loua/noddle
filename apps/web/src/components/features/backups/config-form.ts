import { backupCronSchema, objectPrefixSchema } from "@noddle/shared/validation/backup";
import { dockerVolumeNameSchema } from "@noddle/shared/validation/volume-backup";
import { z } from "zod";

import { DEFAULT_CRON } from "@/components/features/backups/schedule";
import type { BackupConfigRow } from "@/server/backups/configs";
import type { VolumeBackupConfigRow } from "@/server/backups/volume/configs";

const keepLatestCountFormSchema = z.string().refine(
  (value) => {
    const trimmed = value.trim();
    if (trimmed === "") {
      return true;
    }
    const parsed = Number.parseInt(trimmed, 10);
    return Number.isFinite(parsed) && parsed >= 1 && parsed <= 100;
  },
  {
    message: "Enter a number between 1 and 100, or leave empty to keep all.",
  },
);

export function parseKeepLatestCount(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return null;
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed)) {
    throw new TypeError("Keep latest must be a number");
  }
  return parsed;
}

export function configFormDefaults(
  editing: BackupConfigRow | null,
  defaultDatabaseName: string,
  fallbackDestinationId: string,
) {
  if (editing) {
    return {
      databaseName: editing.databaseName,
      destinationId: editing.destinationId,
      enabled: editing.enabled,
      keepLatestCount: editing.keepLatestCount === null ? "" : String(editing.keepLatestCount),
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

export const volumeBackupConfigFormSchema = z.object({
  destinationId: z.uuid("Choose a destination."),
  enabled: z.boolean(),
  keepLatestCount: keepLatestCountFormSchema,
  mountPath: z.string().max(256, "Keep the mount path under 256 characters."),
  prefix: objectPrefixSchema,
  schedule: backupCronSchema,
  volumeName: dockerVolumeNameSchema,
});

export type VolumeBackupConfigFormValues = z.infer<typeof volumeBackupConfigFormSchema>;

export function volumeConfigFormDefaults(
  editing: VolumeBackupConfigRow | null,
  fallbackDestinationId: string,
): VolumeBackupConfigFormValues {
  if (editing) {
    return {
      destinationId: editing.destinationId,
      enabled: editing.enabled,
      keepLatestCount: editing.keepLatestCount === null ? "" : String(editing.keepLatestCount),
      mountPath: editing.mountPath ?? "",
      prefix: editing.prefix,
      schedule: editing.schedule,
      volumeName: editing.volumeName,
    };
  }
  return {
    destinationId: fallbackDestinationId,
    enabled: true,
    keepLatestCount: "",
    mountPath: "",
    prefix: "",
    schedule: DEFAULT_CRON,
    volumeName: "",
  };
}

export function volumeConfigFormToPayload(value: VolumeBackupConfigFormValues) {
  return {
    destinationId: value.destinationId,
    enabled: value.enabled,
    keepLatestCount: parseKeepLatestCount(value.keepLatestCount),
    mountPath: value.mountPath.trim() || undefined,
    prefix: value.prefix,
    schedule: value.schedule.trim(),
    volumeName: value.volumeName.trim(),
  };
}
