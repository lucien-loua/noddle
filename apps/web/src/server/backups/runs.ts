import {
  buildBackupInsert,
  resolveDestination,
  resolveDestinationRow,
} from "@noddle/backup";
import { listObjects } from "@noddle/backup-store";
import { backups } from "@noddle/db/schema";
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
import { guarded, identityTarget } from "@/lib/guarded.server";
import { runGuarded, runRead } from "@/lib/permission.server";
import { enqueueDeploy } from "@/lib/queue.server";
import { requireSession } from "@/lib/session.server";
import { assertRestorableRun, toBackupRunRow } from "@/server/backups/policy";
import type { BackupRunRow } from "@/server/backups/policy";
import { deleteBackupRun } from "@/server/backups/shared";

export type BackupRow = BackupRunRow;

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
    return rows.map(toBackupRunRow);
  });

export const triggerBackup = createServerFn({ method: "POST" })
  .validator(backupRequestSchema)
  .handler(async ({ data }): Promise<{ backupId: string }> => {
    const outcome = await runGuarded({
      ...guarded.backupConfig(data.configId),
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
    return { backupId: outcome.backupId };
  });

export const listBackupObjects = createServerFn({ method: "GET" })
  .validator(listBackupObjectsSchema)
  .handler(async ({ data }): Promise<BackupObjectRow[]> =>
    runRead({
      permission: { action: "restore", resource: "backup" },
      read: async () => {
        const { destination } = await resolveDestination(
          db,
          env.appKey,
          data.destinationId
        );
        const listed = await listObjects(
          { ...destination, prefix: destination.prefix },
          { prefix: data.prefix }
        );
        return listed;
      },
    })
  );

export const deleteBackup = createServerFn({ method: "POST" })
  .validator(deleteBackupRunSchema)
  .handler(async ({ data }): Promise<{ ok: true }> =>
    runGuarded({
      ...guarded.backup(data.backupId),
      permission: { action: "create", resource: "backup" },
      run: ({ row: backup }) =>
        deleteBackupRun(backup, () =>
          db.delete(backups).where(eq(backups.id, backup.id))
        ),
      target: ({ row }) => ({ id: row.id, name: row.objectKey }),
    })
  );

export const triggerRestore = createServerFn({ method: "POST" })
  .validator(restoreRequestSchema)
  .handler(async ({ data }): Promise<{ queued: true }> =>
    runGuarded({
      ...guarded.database(data.databaseId),
      confirmName: { expected: (row) => row.name, typed: data.confirmName },
      permission: { action: "restore", resource: "backup" },
      run: async ({ row: database }) => {
        if (data.backupId) {
          const backup = await db.query.backups.findFirst({
            where: eq(backups.id, data.backupId),
          });
          assertRestorableRun(backup, backup?.databaseId === database.id, {
            noun: "backup",
            owner: "database",
          });
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
      target: identityTarget,
    })
  );
