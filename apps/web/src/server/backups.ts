import {
  buildBackupInsert,
  resolveDestinationRow,
  resolveDestinationSecret,
} from "@noddle/backup";
import { checkDestination } from "@noddle/backup-store";
import { backups, databases, s3Destinations } from "@noddle/db/schema";
import { encryptSecret, secretContext } from "@noddle/shared/crypto";
import {
  backupRequestSchema,
  backupScheduleRequestSchema,
  destinationIdSchema,
  restoreRequestSchema,
  s3DestinationCreateSchema,
  s3DestinationSchema,
} from "@noddle/shared/validation";
import { createServerFn } from "@tanstack/react-start";
import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db.server";
import { env } from "@/lib/env.server";
import { requirePermission } from "@/lib/permission.server";
import { enqueueDeploy } from "@/lib/queue.server";
import { requireSession } from "@/lib/session.server";

function parseDestinationInput(data: unknown) {
  const parsed = s3DestinationSchema.parse(data);
  if (!parsed.id) {
    return s3DestinationCreateSchema.parse(data);
  }
  return parsed;
}

/**
 * The destination as it comes back to the browser: WITHOUT the secret key.
 *
 * It's never sent back, not even encrypted, not even once — like a
 * database's password. The edit form therefore starts with an empty secret
 * field, and leaving it empty keeps the existing key.
 */
export interface DestinationRow {
  accessKeyId: string;
  bucket: string;
  endpoint: string;
  forcePathStyle: boolean;
  id: string;
  name: string;
  prefix: string;
  region: string;
}

export interface BackupRow {
  createdAt: string;
  errorMessage: string | null;
  finishedAt: string | null;
  id: string;
  kind: "manual" | "pre_restore" | "scheduled";
  sizeBytes: number;
  status: "completed" | "failed" | "queued" | "running";
}

export const getDestinations = createServerFn({ method: "GET" }).handler(
  async (): Promise<DestinationRow[]> => {
    await requireSession();
    const rows = await db.query.s3Destinations.findMany({
      orderBy: s3Destinations.name,
    });
    return rows.map((row) => ({
      accessKeyId: row.accessKeyId,
      bucket: row.bucket,
      endpoint: row.endpoint,
      forcePathStyle: row.forcePathStyle,
      id: row.id,
      name: row.name,
      prefix: row.prefix,
      region: row.region,
    }));
  }
);

/**
 * Removes a destination.
 *
 * REFUSED as long as a backup points to it: the object key alone doesn't say
 * which bucket it lives in, so deleting the destination would make those
 * rows unrestorable with nothing to flag it. The database guarantees this
 * too (`on delete restrict`); this check exists to make the refusal
 * readable instead of a constraint error.
 */
export const deleteDestination = createServerFn({ method: "POST" })
  .validator(destinationIdSchema)
  .handler(async ({ data }): Promise<{ ok: true }> => {
    await requirePermission({ action: "create", resource: "backup" });

    const held = await db.query.backups.findFirst({
      where: eq(backups.destinationId, data.id),
    });
    if (held) {
      throw new Error(
        "This destination still holds backups. Delete them first, or they could never be restored."
      );
    }

    await db.delete(s3Destinations).where(eq(s3Destinations.id, data.id));
    return { ok: true };
  });

/**
 * Tests a destination WITHOUT saving it.
 *
 * The same round trip `saveDestination` does before writing — but separate,
 * so identifiers can be checked before replacing the ones that work.
 * Guarded by the same permission: the function receives S3 credentials in
 * the clear, this isn't a read.
 *
 * An empty secret means the same thing as elsewhere: "keep the previous
 * one". Without this, testing an already-saved destination without
 * retyping its key would always fail, which would make the button useless
 * exactly where it's most useful.
 */
export const testDestination = createServerFn({ method: "POST" })
  .validator(parseDestinationInput)
  .handler(async ({ data }): Promise<{ ok: true }> => {
    await requirePermission({ action: "create", resource: "backup" });

    const secret = await resolveDestinationSecret(db, env.appKey, data);
    await checkDestination({
      accessKeyId: data.accessKeyId,
      bucket: data.bucket,
      endpoint: data.endpoint,
      forcePathStyle: data.forcePathStyle,
      prefix: data.prefix,
      region: data.region,
      secretAccessKey: secret,
    });
    return { ok: true };
  });

/**
 * Creates or updates ONE destination.
 *
 * It's TESTED before being written: a write → read → delete round trip
 * against the real service. Saving first and discovering at the first
 * nightly backup that the key isn't allowed to write is exactly the
 * scenario where the user believed they were protected.
 */
export const saveDestination = createServerFn({ method: "POST" })
  .validator(parseDestinationInput)
  .handler(async ({ data }): Promise<{ id: string }> => {
    await requirePermission({ action: "create", resource: "backup" });

    const secret = await resolveDestinationSecret(db, env.appKey, data);

    await checkDestination({
      accessKeyId: data.accessKeyId,
      bucket: data.bucket,
      endpoint: data.endpoint,
      forcePathStyle: data.forcePathStyle,
      prefix: data.prefix,
      region: data.region,
      secretAccessKey: secret,
    });

    if (data.id) {
      await db
        .update(s3Destinations)
        .set({
          accessKeyId: data.accessKeyId,
          bucket: data.bucket,
          endpoint: data.endpoint,
          forcePathStyle: data.forcePathStyle,
          name: data.name,
          prefix: data.prefix,
          region: data.region,
          secretAccessKeyEncrypted: encryptSecret(
            secret,
            env.appKey,
            secretContext.backupDestination(data.id)
          ),
          updatedAt: new Date(),
        })
        .where(eq(s3Destinations.id, data.id));
      return { id: data.id };
    }

    // Encryption is bound to the row's id (AAD), so the row must exist
    // before being encrypted: insert then update, as for a server's SSH
    // key.
    const [created] = await db
      .insert(s3Destinations)
      .values({
        accessKeyId: data.accessKeyId,
        bucket: data.bucket,
        endpoint: data.endpoint,
        forcePathStyle: data.forcePathStyle,
        name: data.name,
        prefix: data.prefix,
        region: data.region,
        secretAccessKeyEncrypted: "placeholder",
      })
      .returning();
    if (!created) {
      throw new Error("could not create destination");
    }
    await db
      .update(s3Destinations)
      .set({
        secretAccessKeyEncrypted: encryptSecret(
          secret,
          env.appKey,
          secretContext.backupDestination(created.id)
        ),
      })
      .where(eq(s3Destinations.id, created.id));
    return { id: created.id };
  });

/**
 * A database's automatic backup schedule.
 *
 * No separate read server function: the dashboard already loads the
 * databases, so `DatabaseRow` carries these two fields and one less query
 * happens at load time.
 */
export const saveBackupSchedule = createServerFn({ method: "POST" })
  .validator(backupScheduleRequestSchema)
  .handler(async ({ data }): Promise<{ saved: true }> => {
    await requirePermission({ action: "create", resource: "backup" });

    const destination = await db.query.s3Destinations.findFirst();
    if (!destination && data.schedule !== "off") {
      throw new Error(
        "no S3 destination configured — a scheduled backup would go nowhere"
      );
    }

    await db
      .update(databases)
      .set({
        backupRetention: data.retention,
        backupSchedule: data.schedule,
        s3DestinationId: data.s3DestinationId,
        updatedAt: new Date(),
      })
      .where(eq(databases.id, data.databaseId));
    return { saved: true };
  });

export const getBackups = createServerFn({ method: "GET" })
  .validator(backupRequestSchema)
  .handler(async ({ data }): Promise<BackupRow[]> => {
    await requireSession();
    const rows = await db.query.backups.findMany({
      limit: 20,
      orderBy: desc(backups.createdAt),
      where: eq(backups.databaseId, data.databaseId),
    });
    return rows.map((b) => ({
      createdAt: b.createdAt.toISOString(),
      errorMessage: b.errorMessage,
      finishedAt: b.finishedAt?.toISOString() ?? null,
      id: b.id,
      kind: b.kind,
      sizeBytes: b.sizeBytes,
      status: b.status,
    }));
  });

/**
 * Triggers a backup.
 *
 * The destination AND the object key are decided HERE, TOGETHER, before the
 * job — via `buildBackupInsert`, the same builder as `sweepBackups` (both
 * Bun AND Node need it, hence `@noddle/backup`). Previously, this function
 * picked an arbitrary destination (`findFirst()`, ignoring
 * `database.s3DestinationId`) for the key, while the worker resolved a
 * different one for the actual upload: the key could carry the prefix of a
 * bucket different from the one the object landed in. A single call to
 * `resolveDestinationRow` rules out this divergence by construction.
 *
 * If the worker dies between enqueueing and execution, we still know which
 * object — and which destination — the row was meant to produce.
 */
export const triggerBackup = createServerFn({ method: "POST" })
  .validator(backupRequestSchema)
  .handler(async ({ data }): Promise<{ backupId: string }> => {
    await requirePermission({ action: "create", resource: "backup" });

    const database = await db.query.databases.findFirst({
      where: eq(databases.id, data.databaseId),
    });
    if (!database) {
      throw new Error("database not found");
    }
    const resolved = await resolveDestinationRow(db, database.s3DestinationId);

    const [created] = await db
      .insert(backups)
      .values(buildBackupInsert({ database, kind: "manual", resolved }))
      .returning();
    if (!created) {
      throw new Error("could not create backup");
    }

    await enqueueDeploy({ backupId: created.id, kind: "backup" });
    return { backupId: created.id };
  });

/**
 * Triggers a restore.
 *
 * `confirmName` is checked HERE, not just in the dialog. A safeguard that
 * only lives in the component only protects the clients that show it; the
 * operation destroys data with no way back, so it's refused server-side.
 * (`deleteService` has followed the same rule since a service became
 * deletable.)
 */
export const triggerRestore = createServerFn({ method: "POST" })
  .validator(restoreRequestSchema)
  .handler(async ({ data }): Promise<{ queued: true }> => {
    await requirePermission({ action: "restore", resource: "backup" });

    const database = await db.query.databases.findFirst({
      where: eq(databases.id, data.databaseId),
    });
    if (!database) {
      throw new Error("database not found");
    }
    if (data.confirmName !== database.name) {
      throw new Error(
        `the name you typed does not match "${database.name}" — restore cancelled`
      );
    }

    const backup = await db.query.backups.findFirst({
      where: eq(backups.id, data.backupId),
    });
    if (!backup || backup.databaseId !== database.id) {
      throw new Error("backup not found for this database");
    }
    if (backup.status !== "completed") {
      throw new Error(
        "only a completed backup can be restored — this one is not"
      );
    }

    await enqueueDeploy({
      backupId: backup.id,
      databaseId: database.id,
      kind: "restore",
    });
    return { queued: true };
  });
