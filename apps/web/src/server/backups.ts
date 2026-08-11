import {
  buildBackupInsert,
  resolveDestination,
  resolveDestinationRow,
  resolveDestinationSecret,
} from "@noddle/backup";
import {
  checkDestination,
  deleteObject,
  listObjects,
} from "@noddle/backup-store";
import {
  backupConfigs,
  backups,
  databases,
  s3Destinations,
} from "@noddle/db/schema";
import { encryptSecret, secretContext } from "@noddle/shared/crypto";
import {
  backupConfigIdSchema,
  backupRequestSchema,
  createBackupConfigSchema,
  deleteBackupRunSchema,
  destinationIdSchema,
  listBackupObjectsSchema,
  listBackupsSchema,
  restoreRequestSchema,
  s3DestinationCreateSchema,
  s3DestinationSchema,
  updateBackupConfigSchema,
} from "@noddle/shared/validation/backup";
import { createServerFn } from "@tanstack/react-start";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
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

export interface BackupConfigRow {
  createdAt: string;
  databaseId: string;
  databaseName: string;
  destinationId: string;
  destinationName: string;
  enabled: boolean;
  id: string;
  keepLatestCount: number | null;
  prefix: string;
  schedule: string;
  updatedAt: string;
}

export interface BackupRow {
  configId: string | null;
  createdAt: string;
  errorMessage: string | null;
  finishedAt: string | null;
  id: string;
  kind: "manual" | "pre_restore" | "scheduled";
  objectKey: string;
  sizeBytes: number;
  status: "completed" | "failed" | "queued" | "running";
}

export interface BackupObjectRow {
  key: string;
  lastModified: string | null;
  sizeBytes: number;
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
 * REFUSED as long as a backup run OR a config points to it.
 */
export const deleteDestination = createServerFn({ method: "POST" })
  .validator(destinationIdSchema)
  .handler(async ({ data }): Promise<{ ok: true }> => {
    await requirePermission({ action: "create", resource: "backup" });

    const heldRun = await db.query.backups.findFirst({
      where: eq(backups.destinationId, data.id),
    });
    if (heldRun) {
      throw new Error(
        "This destination still holds backups. Delete them first, or they could never be restored."
      );
    }
    const heldConfig = await db.query.backupConfigs.findFirst({
      where: eq(backupConfigs.destinationId, data.id),
    });
    if (heldConfig) {
      throw new Error(
        "This destination is still used by a backup config. Delete the config first."
      );
    }

    await db.delete(s3Destinations).where(eq(s3Destinations.id, data.id));
    return { ok: true };
  });

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

export const listBackupConfigs = createServerFn({ method: "GET" })
  .validator(z.object({ databaseId: z.uuid() }))
  .handler(async ({ data }): Promise<BackupConfigRow[]> => {
    await requireSession();
    const rows = await db.query.backupConfigs.findMany({
      orderBy: desc(backupConfigs.createdAt),
      where: eq(backupConfigs.databaseId, data.databaseId),
      with: { destination: true },
    });
    return rows.map((row) => ({
      createdAt: row.createdAt.toISOString(),
      databaseId: row.databaseId,
      databaseName: row.databaseName,
      destinationId: row.destinationId,
      destinationName: row.destination.name,
      enabled: row.enabled,
      id: row.id,
      keepLatestCount: row.keepLatestCount,
      prefix: row.prefix,
      schedule: row.schedule,
      updatedAt: row.updatedAt.toISOString(),
    }));
  });

export const createBackupConfig = createServerFn({ method: "POST" })
  .validator(createBackupConfigSchema)
  .handler(async ({ data }): Promise<{ configId: string }> => {
    await requirePermission({ action: "create", resource: "backup" });

    const database = await db.query.databases.findFirst({
      where: eq(databases.id, data.databaseId),
    });
    if (!database) {
      throw new Error("database not found");
    }
    const destination = await db.query.s3Destinations.findFirst({
      where: eq(s3Destinations.id, data.destinationId),
    });
    if (!destination) {
      throw new Error("S3 destination not found");
    }

    const [created] = await db
      .insert(backupConfigs)
      .values({
        databaseId: data.databaseId,
        databaseName: data.databaseName,
        destinationId: data.destinationId,
        enabled: data.enabled,
        keepLatestCount: data.keepLatestCount,
        prefix: data.prefix,
        schedule: data.schedule.trim(),
      })
      .returning();
    if (!created) {
      throw new Error("could not create backup config");
    }
    return { configId: created.id };
  });

export const updateBackupConfig = createServerFn({ method: "POST" })
  .validator(updateBackupConfigSchema)
  .handler(async ({ data }): Promise<{ saved: true }> => {
    await requirePermission({ action: "create", resource: "backup" });

    const existing = await db.query.backupConfigs.findFirst({
      where: eq(backupConfigs.id, data.configId),
    });
    if (!existing) {
      throw new Error("backup config not found");
    }
    const destination = await db.query.s3Destinations.findFirst({
      where: eq(s3Destinations.id, data.destinationId),
    });
    if (!destination) {
      throw new Error("S3 destination not found");
    }

    await db
      .update(backupConfigs)
      .set({
        databaseName: data.databaseName,
        destinationId: data.destinationId,
        enabled: data.enabled,
        keepLatestCount: data.keepLatestCount,
        prefix: data.prefix,
        schedule: data.schedule.trim(),
        updatedAt: new Date(),
      })
      .where(eq(backupConfigs.id, data.configId));
    return { saved: true };
  });

export const deleteBackupConfig = createServerFn({ method: "POST" })
  .validator(backupConfigIdSchema)
  .handler(async ({ data }): Promise<{ ok: true }> => {
    await requirePermission({ action: "create", resource: "backup" });
    await db.delete(backupConfigs).where(eq(backupConfigs.id, data.configId));
    return { ok: true };
  });

export const getBackups = createServerFn({ method: "GET" })
  .validator(listBackupsSchema)
  .handler(async ({ data }): Promise<BackupRow[]> => {
    await requireSession();
    const rows = await db.query.backups.findMany({
      limit: 50,
      orderBy: desc(backups.createdAt),
      where: data.configId
        ? and(
            eq(backups.databaseId, data.databaseId),
            eq(backups.configId, data.configId)
          )
        : eq(backups.databaseId, data.databaseId),
    });
    return rows.map((b) => ({
      configId: b.configId,
      createdAt: b.createdAt.toISOString(),
      errorMessage: b.errorMessage,
      finishedAt: b.finishedAt?.toISOString() ?? null,
      id: b.id,
      kind: b.kind,
      objectKey: b.objectKey,
      sizeBytes: b.sizeBytes,
      status: b.status,
    }));
  });

/**
 * Triggers a manual backup for a config.
 */
export const triggerBackup = createServerFn({ method: "POST" })
  .validator(backupRequestSchema)
  .handler(async ({ data }): Promise<{ backupId: string }> => {
    await requirePermission({ action: "create", resource: "backup" });

    const config = await db.query.backupConfigs.findFirst({
      where: eq(backupConfigs.id, data.configId),
      with: { database: true },
    });
    if (!config) {
      throw new Error("backup config not found");
    }

    const resolved = await resolveDestinationRow(db, config.destinationId);
    const [created] = await db
      .insert(backups)
      .values(
        buildBackupInsert({
          configId: config.id,
          configPrefix: config.prefix,
          database: config.database,
          databaseName: config.databaseName,
          kind: "manual",
          resolved,
        })
      )
      .returning();
    if (!created) {
      throw new Error("could not create backup");
    }

    await enqueueDeploy({ backupId: created.id, kind: "backup" });
    return { backupId: created.id };
  });

export const listBackupObjects = createServerFn({ method: "GET" })
  .validator(listBackupObjectsSchema)
  .handler(async ({ data }): Promise<BackupObjectRow[]> => {
    await requirePermission({ action: "restore", resource: "backup" });

    const { destination } = await resolveDestination(
      db,
      env.appKey,
      data.destinationId
    );
    // Destination prefix is already applied inside listObjects; pass only
    // the optional extra path from the picker.
    const listed = await listObjects(
      { ...destination, prefix: destination.prefix },
      { prefix: data.prefix }
    );
    return listed;
  });

/**
 * Deletes one completed/failed run and its S3 object.
 */
export const deleteBackup = createServerFn({ method: "POST" })
  .validator(deleteBackupRunSchema)
  .handler(async ({ data }): Promise<{ ok: true }> => {
    await requirePermission({ action: "create", resource: "backup" });

    const backup = await db.query.backups.findFirst({
      where: eq(backups.id, data.backupId),
    });
    if (!backup) {
      throw new Error("backup not found");
    }
    if (backup.status === "queued" || backup.status === "running") {
      throw new Error("cannot delete a backup that is still in progress");
    }

    if (backup.destinationId) {
      try {
        const { destination } = await resolveDestination(
          db,
          env.appKey,
          backup.destinationId
        );
        await deleteObject(destination, backup.objectKey);
      } catch {
        // Object may already be gone; still drop the row.
      }
    }

    await db.delete(backups).where(eq(backups.id, backup.id));
    return { ok: true };
  });

/**
 * Triggers a restore from a completed run or a raw S3 object.
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

    if (data.backupId) {
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
    }

    if (!(data.destinationId && data.objectKey)) {
      throw new Error("destinationId and objectKey are required");
    }

    await enqueueDeploy({
      databaseId: database.id,
      destinationId: data.destinationId,
      kind: "restore",
      objectKey: data.objectKey,
    });
    return { queued: true };
  });
