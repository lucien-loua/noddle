import {
  buildBackupInsert,
  resolveDestination,
  resolveDestinationRow,
} from "@noddle/backup";
import { deleteObject, listObjects } from "@noddle/backup-store";
import { backupConfigs, backups, databases } from "@noddle/db/schema";
import {
  backupRequestSchema,
  deleteBackupRunSchema,
  listBackupObjectsSchema,
  listBackupsSchema,
  restoreRequestSchema,
} from "@noddle/shared/validation/backup";
import { createServerFn } from "@tanstack/react-start";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db.server";
import { env } from "@/lib/env.server";
import { runGuarded, runRead } from "@/lib/permission.server";
import { enqueueDeploy } from "@/lib/queue.server";
import { requireSession } from "@/lib/session.server";

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
    const guarded = await runGuarded({
      load: () =>
        db.query.backupConfigs.findFirst({
          where: eq(backupConfigs.id, data.configId),
          with: { database: true },
        }),
      notFoundMessage: "backup config not found",
      permission: { action: "create", resource: "backup" },
      run: async ({ row: config }) => {
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
        return { backupId: created.id, name: config.database.name };
      },
      target: ({ result }) => ({ id: result.backupId, name: result.name }),
    });
    return { backupId: guarded.backupId };
  });

export const listBackupObjects = createServerFn({ method: "GET" })
  .validator(listBackupObjectsSchema)
  .handler(
    async ({ data }): Promise<BackupObjectRow[]> =>
      runRead({
        permission: { action: "restore", resource: "backup" },
        read: async () => {
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
        },
      })
  );

/**
 * Deletes one completed/failed run and its S3 object.
 */
export const deleteBackup = createServerFn({ method: "POST" })
  .validator(deleteBackupRunSchema)
  .handler(
    async ({ data }): Promise<{ ok: true }> =>
      runGuarded({
        load: () =>
          db.query.backups.findFirst({ where: eq(backups.id, data.backupId) }),
        notFoundMessage: "backup not found",
        permission: { action: "create", resource: "backup" },
        run: async ({ row: backup }) => {
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
          return { ok: true as const };
        },
        target: ({ row }) => ({ id: row.id, name: row.objectKey }),
      })
  );

/**
 * Triggers a restore from a completed run or a raw S3 object.
 */
export const triggerRestore = createServerFn({ method: "POST" })
  .validator(restoreRequestSchema)
  .handler(
    async ({ data }): Promise<{ queued: true }> =>
      runGuarded({
        confirmName: { expected: (row) => row.name, typed: data.confirmName },
        load: () =>
          db.query.databases.findFirst({
            where: eq(databases.id, data.databaseId),
          }),
        notFoundMessage: "database not found",
        permission: { action: "restore", resource: "backup" },
        run: async ({ row: database }) => {
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
        },
        target: ({ row }) => ({ id: row.id, name: row.name }),
      })
  );
