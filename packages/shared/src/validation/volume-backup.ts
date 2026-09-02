import { z } from "zod";

import { SAFE_SHELL_IDENTIFIER } from "../shell-identifier.ts";
import { backupCronSchema, objectPrefixSchema } from "./backup.ts";

export const dockerVolumeNameSchema = z
  .string()
  .min(1, "Volume name is required.")
  .max(128, "Keep the volume name under 128 characters.")
  .regex(
    SAFE_SHELL_IDENTIFIER,
    "Use letters, digits, underscores, dots and hyphens."
  );

export const volumeBackupConfigInputSchema = z.object({
  destinationId: z.uuid("Choose a destination."),
  enabled: z.boolean().default(true),
  keepLatestCount: z
    .int("Enter a whole number.")
    .min(1, "Keep at least 1 backup.")
    .max(100, "Keep at most 100 backups.")
    .nullable()
    .default(null),
  mountPath: z
    .string()
    .max(256, "Keep the mount path under 256 characters.")
    .optional(),
  prefix: objectPrefixSchema.default(""),
  schedule: backupCronSchema,
  serviceId: z.uuid("Choose a service."),
  volumeName: dockerVolumeNameSchema,
});

export type VolumeBackupConfigInput = z.infer<
  typeof volumeBackupConfigInputSchema
>;

export const createVolumeBackupConfigSchema = volumeBackupConfigInputSchema;

export const updateVolumeBackupConfigSchema = volumeBackupConfigInputSchema
  .omit({ serviceId: true })
  .extend({ configId: z.uuid("Choose a backup schedule.") });

export const volumeBackupConfigIdSchema = z.object({
  configId: z.uuid("Choose a backup schedule."),
});

export const volumeBackupRequestSchema = z.object({
  configId: z.uuid("Choose a backup schedule."),
});

export const listVolumeBackupsSchema = z.object({
  configId: z.uuid("Choose a backup schedule.").optional(),
  serviceId: z.uuid("Choose a service."),
});

export const deleteVolumeBackupRunSchema = z.object({
  backupId: z.uuid("Choose a backup."),
});

export const volumeRestoreRequestSchema = z
  .object({
    backupId: z.uuid("Choose a backup.").optional(),
    confirmName: z
      .string()
      .min(1, "Type the service name to confirm.")
      .max(48, "Keep the name under 48 characters."),
    destinationId: z.uuid("Choose a destination.").optional(),
    objectKey: z
      .string()
      .min(1, "Choose a backup file.")
      .max(1024, "Keep the object key under 1024 characters.")
      .optional(),
    serviceId: z.uuid("Choose a service."),
    volumeName: dockerVolumeNameSchema.optional(),
  })
  .superRefine((data, ctx) => {
    const fromRun = Boolean(data.backupId);
    const fromObject = Boolean(data.destinationId && data.objectKey);
    if (fromRun === fromObject) {
      ctx.addIssue({
        code: "custom",
        message:
          "provide either backupId, or destinationId and objectKey together",
      });
    }
    if (fromObject && !data.volumeName) {
      ctx.addIssue({
        code: "custom",
        message: "volumeName is required when restoring from an S3 object",
        path: ["volumeName"],
      });
    }
  });

export type VolumeRestoreRequest = z.infer<typeof volumeRestoreRequestSchema>;
