import {
  backupCronSchema,
  objectPrefixSchema,
} from "@noddle/shared/validation/backup";
import { dockerVolumeNameSchema } from "@noddle/shared/validation/volume-backup";
import { z } from "zod";
import { DEFAULT_CRON } from "@/components/features/backup-shared/schedule";
import type { VolumeBackupConfigRow } from "@/server/volume-backups";

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
  }
);

export const volumeBackupConfigFormSchema = z.object({
  destinationId: z.uuid("Choose a destination."),
  enabled: z.boolean(),
  keepLatestCount: keepLatestCountFormSchema,
  mountPath: z.string().max(256, "Keep the mount path under 256 characters."),
  prefix: objectPrefixSchema,
  schedule: backupCronSchema,
  volumeName: dockerVolumeNameSchema,
});

export type VolumeBackupConfigFormValues = z.infer<
  typeof volumeBackupConfigFormSchema
>;

export function volumeConfigFormDefaults(
  editing: VolumeBackupConfigRow | null,
  fallbackDestinationId: string
): VolumeBackupConfigFormValues {
  if (editing) {
    return {
      destinationId: editing.destinationId,
      enabled: editing.enabled,
      keepLatestCount:
        editing.keepLatestCount === null ? "" : String(editing.keepLatestCount),
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
  const keepRaw = value.keepLatestCount.trim();
  return {
    destinationId: value.destinationId,
    enabled: value.enabled,
    keepLatestCount: keepRaw === "" ? null : Number.parseInt(keepRaw, 10),
    mountPath: value.mountPath.trim() || undefined,
    prefix: value.prefix,
    schedule: value.schedule.trim(),
    volumeName: value.volumeName.trim(),
  };
}
