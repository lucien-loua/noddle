import { z } from "zod";

import {
  HTTP_OR_HTTPS_URL,
  LEADING_SLASHES,
  TRAILING_SLASHES,
} from "./common.ts";

export const bucketNameSchema = z
  .string()
  .min(3, "Bucket names are at least 3 characters.")
  .max(63, "Keep the bucket name under 63 characters.")
  .regex(
    /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/,
    "Lowercase letters, digits, dots and dashes; start and end alphanumeric."
  );

export const objectPrefixSchema = z
  .string()
  .max(256, "Keep the prefix under 256 characters.")
  .regex(/^[a-zA-Z0-9!\-_.*'()/]*$/, "only characters safe for an S3 key")
  .refine((v) => !v.includes(".."), "`..` is not allowed in a prefix")
  .transform((v) =>
    v.replace(LEADING_SLASHES, "").replace(TRAILING_SLASHES, "")
  );

export const s3DestinationSchema = z.object({
  accessKeyId: z
    .string()
    .min(1, "Enter the access key ID.")
    .max(128, "Keep the access key ID under 128 characters."),
  bucket: bucketNameSchema,
  endpoint: z
    .string()
    .min(1, "Enter the S3 service URL.")
    .max(512, "Keep the endpoint under 512 characters.")
    .refine(
      (v) => HTTP_OR_HTTPS_URL.test(v),
      "Enter an http:// or https:// URL."
    ),
  forcePathStyle: z.boolean().default(true),

  id: z.uuid("Choose a destination.").optional(),

  name: z
    .string()
    .min(1, "Give this destination a name.")
    .max(64, "Keep the name under 64 characters."),
  prefix: objectPrefixSchema.default(""),
  region: z
    .string()
    .min(1, "Enter a region.")
    .max(64, "Keep the region under 64 characters.")
    .default("us-east-1"),
  secretAccessKey: z
    .string()
    .max(256, "Keep the secret access key under 256 characters."),
});

export const s3DestinationCreateSchema = s3DestinationSchema.refine(
  (v) => v.secretAccessKey.length > 0,
  {
    message: "A secret access key is required.",
    path: ["secretAccessKey"],
  }
);

export const destinationIdSchema = z.object({
  id: z.uuid("Choose a destination."),
});

export type BackupDestinationInput = z.infer<typeof s3DestinationSchema>;

export const backupRequestSchema = z.object({
  configId: z.uuid("Choose a backup schedule."),
});

export type BackupRequest = z.infer<typeof backupRequestSchema>;

export const listBackupsSchema = z.object({
  configId: z.uuid("Choose a backup schedule.").optional(),
  databaseId: z.uuid("Choose a database."),
});

export type ListBackupsRequest = z.infer<typeof listBackupsSchema>;

export const BACKUP_CRON_PRESETS = [
  { cron: "* * * * *", label: "Every minute" },
  { cron: "0 * * * *", label: "Every hour" },
  { cron: "0 0 * * *", label: "Every day at midnight" },
  { cron: "0 0 * * 0", label: "Every Sunday at midnight" },
  { cron: "0 0 1 * *", label: "Every month on the 1st at midnight" },
  { cron: "*/15 * * * *", label: "Every 15 minutes" },
  { cron: "0 0 * * 1-5", label: "Every weekday at midnight" },
] as const;

const CRON_FIELD = String.raw`(\*|\*/\d+|\d+(-\d+)?(,\d+(-\d+)?)*)`;
const CRON_RE = new RegExp(`^${CRON_FIELD}( ${CRON_FIELD}){4}$`);

export const backupCronSchema = z
  .string()
  .min(1, "Schedule is required.")
  .max(64, "Keep the cron under 64 characters.")
  .refine((v) => CRON_RE.test(v.trim()), "Enter a five-field cron expression.");

export const backupConfigInputSchema = z.object({
  databaseId: z.uuid("Choose a database."),
  databaseName: z
    .string()
    .min(1, "Database name is required.")
    .max(64, "Keep the database name under 64 characters."),
  destinationId: z.uuid("Choose a destination."),
  enabled: z.boolean().default(true),
  keepLatestCount: z
    .number({ error: "Enter how many backups to keep." })
    .int("Enter a whole number.")
    .min(1, "Keep at least 1 backup.")
    .max(100, "Keep at most 100 backups.")
    .nullable()
    .default(null),
  prefix: objectPrefixSchema.default(""),
  schedule: backupCronSchema,
});

export type BackupConfigInput = z.infer<typeof backupConfigInputSchema>;

export const createBackupConfigSchema = backupConfigInputSchema;

export const updateBackupConfigSchema = backupConfigInputSchema
  .omit({ databaseId: true })
  .extend({ configId: z.uuid("Choose a backup schedule.") });

export type UpdateBackupConfigRequest = z.infer<
  typeof updateBackupConfigSchema
>;

export const backupConfigIdSchema = z.object({
  configId: z.uuid("Choose a backup schedule."),
});

export const listBackupObjectsSchema = z.object({
  destinationId: z.uuid("Choose a destination."),
  prefix: objectPrefixSchema.optional(),
});

export type ListBackupObjectsRequest = z.infer<typeof listBackupObjectsSchema>;

export const deleteBackupRunSchema = z.object({
  backupId: z.uuid("Choose a backup."),
});

export const restoreRequestSchema = z
  .object({
    backupId: z.uuid("Choose a backup.").optional(),
    confirmName: z
      .string()
      .min(1, "Type the database name to confirm.")
      .max(48, "Keep the name under 48 characters."),
    databaseId: z.uuid("Choose a database."),
    destinationId: z.uuid("Choose a destination.").optional(),
    objectKey: z
      .string()
      .min(1, "Choose a backup file.")
      .max(1024, "Keep the object key under 1024 characters.")
      .optional(),
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
  });

export type RestoreRequest = z.infer<typeof restoreRequestSchema>;
