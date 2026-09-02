import { buildVolumeBackupInsert, resolveDestinationRow } from "@noddle/backup";
import { volumeBackups } from "@noddle/db/schema";
import {
  deleteVolumeBackupRunSchema,
  listVolumeBackupsSchema,
  volumeBackupRequestSchema,
  volumeRestoreRequestSchema,
} from "@noddle/shared/validation/volume-backup";
import { createServerFn } from "@tanstack/react-start";
import { and, desc, eq } from "drizzle-orm";

import { db } from "@/lib/db.server";
import { guarded, identityTarget } from "@/lib/guarded.server";
import { runGuarded } from "@/lib/permission.server";
import { enqueueDeploy } from "@/lib/queue.server";
import { requireSession } from "@/lib/session.server";
import { assertRestorableRun, toBackupRunRow } from "@/server/backups/policy";
import type { BackupRunRow } from "@/server/backups/policy";
import { deleteBackupRun } from "@/server/backups/shared";

export type VolumeBackupRow = BackupRunRow;

export const getVolumeBackups = createServerFn({ method: "GET" })
  .validator(listVolumeBackupsSchema)
  .handler(async ({ data }): Promise<VolumeBackupRow[]> => {
    await requireSession();
    const rows = await db.query.volumeBackups.findMany({
      limit: 50,
      orderBy: desc(volumeBackups.createdAt),
      where: data.configId
        ? and(
            eq(volumeBackups.serviceId, data.serviceId),
            eq(volumeBackups.configId, data.configId)
          )
        : eq(volumeBackups.serviceId, data.serviceId),
    });
    return rows.map(toBackupRunRow);
  });

export const triggerVolumeBackup = createServerFn({ method: "POST" })
  .validator(volumeBackupRequestSchema)
  .handler(async ({ data }): Promise<{ volumeBackupId: string }> => {
    const outcome = await runGuarded({
      ...guarded.volumeBackupConfig(data.configId),
      permission: { action: "create", resource: "backup" },
      run: async ({ row: config }) => {
        const resolved = await resolveDestinationRow(db, config.destinationId);
        const [created] = await db
          .insert(volumeBackups)
          .values(
            buildVolumeBackupInsert({
              configId: config.id,
              configPrefix: config.prefix,
              kind: "manual",
              resolved,
              service: config.service,
              volumeName: config.volumeName,
            })
          )
          .returning();
        if (!created) {
          throw new Error("could not create volume backup");
        }

        await enqueueDeploy({
          kind: "volume-backup",
          volumeBackupId: created.id,
        });
        return { name: config.service.name, volumeBackupId: created.id };
      },
      target: ({ result }) => ({
        id: result.volumeBackupId,
        name: result.name,
      }),
    });
    return { volumeBackupId: outcome.volumeBackupId };
  });

export const deleteVolumeBackup = createServerFn({ method: "POST" })
  .validator(deleteVolumeBackupRunSchema)
  .handler(async ({ data }): Promise<{ ok: true }> =>
    runGuarded({
      ...guarded.volumeBackup(data.backupId),
      permission: { action: "create", resource: "backup" },
      run: ({ row: backup }) =>
        deleteBackupRun(backup, () =>
          db.delete(volumeBackups).where(eq(volumeBackups.id, backup.id))
        ),
      target: ({ row }) => ({ id: row.id, name: row.objectKey }),
    })
  );

export const triggerVolumeRestore = createServerFn({ method: "POST" })
  .validator(volumeRestoreRequestSchema)
  .handler(async ({ data }): Promise<{ queued: true }> =>
    runGuarded({
      ...guarded.service(data.serviceId),
      confirmName: { expected: (row) => row.name, typed: data.confirmName },
      permission: { action: "restore", resource: "backup" },
      run: async ({ row: service }) => {
        if (data.backupId) {
          const backup = await db.query.volumeBackups.findFirst({
            where: eq(volumeBackups.id, data.backupId),
          });
          assertRestorableRun(backup, backup?.serviceId === service.id, {
            noun: "volume backup",
            owner: "service",
          });
          await enqueueDeploy({
            kind: "volume-restore",
            serviceId: service.id,
            volumeBackupId: data.backupId,
          });
          return { queued: true as const };
        }

        if (!(data.destinationId && data.objectKey && data.volumeName)) {
          throw new Error(
            "destinationId, objectKey and volumeName are required"
          );
        }

        await enqueueDeploy({
          destinationId: data.destinationId,
          kind: "volume-restore",
          objectKey: data.objectKey,
          serviceId: service.id,
          volumeName: data.volumeName,
        });
        return { queued: true as const };
      },
      target: identityTarget,
    })
  );
