import { z } from "zod";
import {
  HTTP_OR_HTTPS_URL,
  LEADING_SLASHES,
  TRAILING_SLASHES,
} from "./common.ts";

/**
 * AWS's rules, not ours: 3 to 63 characters, lowercase, digits, dots and
 * dashes, starting and ending with an alphanumeric character. A bucket in
 * uppercase is refused by the service itself, so might as well say so in
 * the form rather than at the first backup.
 */
export const bucketNameSchema = z
  .string()
  .min(3, "Bucket names are at least 3 characters.")
  .max(63, "Keep the bucket name under 63 characters.")
  .regex(
    /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/,
    "Lowercase letters, digits, dots and dashes; start and end alphanumeric."
  );

/**
 * Key prefix. Optional, and normalized without a leading or trailing `/`:
 * it's glued back together with an explicit separator when building the
 * key, and two sources of truth about who adds the slash would produce
 * `noddle//database/…` keys.
 */
export const objectPrefixSchema = z
  .string()
  .max(256, "Keep the prefix under 256 characters.")
  .regex(/^[a-zA-Z0-9!\-_.*'()/]*$/, "only characters safe for an S3 key")
  .refine((v) => !v.includes(".."), "`..` is not allowed in a prefix")
  .transform((v) =>
    v.replace(LEADING_SLASHES, "").replace(TRAILING_SLASHES, "")
  );

/**
 * Wire format for an S3 destination (create or update).
 *
 * Messages are WRITTEN, not left to Zod's default: they surface under the
 * field in the form and in the server-function error — one place to fix.
 *
 * EMPTY `secretAccessKey` is allowed on purpose: on an already-registered
 * destination, a field left empty means "keep the stored key". Creation
 * uses {@link s3DestinationCreateSchema}, which requires a secret.
 */
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
  // True everywhere except on Amazon's own S3: `bucket.host` doesn't
  // resolve for RustFS, MinIO or an instance reached by IP.
  forcePathStyle: z.boolean().default(true),

  /** Absent = creation. Present = updating THIS destination. */
  id: z.uuid().optional(),

  // What distinguishes two buckets in a selector. A URL isn't enough: two
  // buckets on the same service share the same host.
  name: z
    .string()
    .min(1, "Give this destination a name.")
    .max(64, "Keep the name under 64 characters."),
  prefix: objectPrefixSchema.default(""),
  // Enters into the SigV4 signature computation: a wrong region makes
  // authentication fail, even on an implementation that otherwise ignores
  // it.
  region: z
    .string()
    .min(1, "Enter a region.")
    .max(64, "Keep the region under 64 characters.")
    .default("us-east-1"),
  secretAccessKey: z
    .string()
    .max(256, "Keep the secret access key under 256 characters."),
});

/** Creation: same fields, but a secret is required (nothing to keep yet). */
export const s3DestinationCreateSchema = s3DestinationSchema.refine(
  (v) => v.secretAccessKey.length > 0,
  {
    message: "A secret access key is required.",
    path: ["secretAccessKey"],
  }
);

export const destinationIdSchema = z.object({ id: z.uuid() });

export type BackupDestinationInput = z.infer<typeof s3DestinationSchema>;

export const backupRequestSchema = z.object({
  configId: z.uuid(),
});

export type BackupRequest = z.infer<typeof backupRequestSchema>;

export const listBackupsSchema = z.object({
  configId: z.uuid().optional(),
  databaseId: z.uuid(),
});

export type ListBackupsRequest = z.infer<typeof listBackupsSchema>;

/** Common cron presets; the form also allows a free-form custom expression. */
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
  databaseId: z.uuid(),
  databaseName: z
    .string()
    .min(1, "Database name is required.")
    .max(64, "Keep the database name under 64 characters."),
  destinationId: z.uuid(),
  enabled: z.boolean().default(true),
  keepLatestCount: z.number().int().min(1).max(100).nullable().default(null),
  prefix: objectPrefixSchema.default(""),
  schedule: backupCronSchema,
});

export type BackupConfigInput = z.infer<typeof backupConfigInputSchema>;

export const createBackupConfigSchema = backupConfigInputSchema;

export const updateBackupConfigSchema = backupConfigInputSchema
  .omit({ databaseId: true })
  .extend({ configId: z.uuid() });

export type UpdateBackupConfigRequest = z.infer<
  typeof updateBackupConfigSchema
>;

export const backupConfigIdSchema = z.object({ configId: z.uuid() });

export const listBackupObjectsSchema = z.object({
  destinationId: z.uuid(),
  prefix: objectPrefixSchema.optional(),
});

export type ListBackupObjectsRequest = z.infer<typeof listBackupObjectsSchema>;

export const deleteBackupRunSchema = z.object({
  backupId: z.uuid(),
});

/**
 * Restoring is the product's ONLY irreversible operation: it overwrites
 * current data, whereas replaying an image destroys nothing.
 *
 * Provide either `backupId` (completed run) or `destinationId` + `objectKey`
 * (raw S3 object). `confirmName` is re-checked server-side.
 */
export const restoreRequestSchema = z
  .object({
    backupId: z.uuid().optional(),
    confirmName: z.string().min(1).max(48),
    databaseId: z.uuid(),
    destinationId: z.uuid().optional(),
    objectKey: z.string().min(1).max(1024).optional(),
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
