import { z } from "zod";
import { backupCronSchema, objectPrefixSchema } from "./backup.ts";

/** Docker volume names: letters, digits, underscore, dot, hyphen. */
export const dockerVolumeNameSchema = z
  .string()
  .min(1, "Volume name is required.")
  .max(128, "Keep the volume name under 128 characters.")
  .regex(
    /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/,
    "Use letters, digits, underscores, dots and hyphens."
  );

export const volumeBackupConfigInputSchema = z.object({
  destinationId: z.uuid(),
  enabled: z.boolean().default(true),
  keepLatestCount: z.number().int().min(1).max(100).nullable().default(null),
  mountPath: z
    .string()
    .max(256, "Keep the mount path under 256 characters.")
    .optional(),
  prefix: objectPrefixSchema.default(""),
  schedule: backupCronSchema,
  serviceId: z.uuid(),
  volumeName: dockerVolumeNameSchema,
});

export type VolumeBackupConfigInput = z.infer<
  typeof volumeBackupConfigInputSchema
>;

export const createVolumeBackupConfigSchema = volumeBackupConfigInputSchema;

export const updateVolumeBackupConfigSchema = volumeBackupConfigInputSchema
  .omit({ serviceId: true })
  .extend({ configId: z.uuid() });

export const volumeBackupConfigIdSchema = z.object({ configId: z.uuid() });

export const volumeBackupRequestSchema = z.object({
  configId: z.uuid(),
});

export const listVolumeBackupsSchema = z.object({
  configId: z.uuid().optional(),
  serviceId: z.uuid(),
});

export const deleteVolumeBackupRunSchema = z.object({
  backupId: z.uuid(),
});

export const volumeRestoreRequestSchema = z
  .object({
    backupId: z.uuid().optional(),
    confirmName: z.string().min(1).max(48),
    destinationId: z.uuid().optional(),
    objectKey: z.string().min(1).max(1024).optional(),
    serviceId: z.uuid(),
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
