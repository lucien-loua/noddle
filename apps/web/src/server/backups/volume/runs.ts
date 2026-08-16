import {
  buildVolumeBackupInsert,
  resolveDestination,
  resolveDestinationRow,
} from "@noddle/backup";
import { deleteObject } from "@noddle/backup-store";
import {
  services,
  volumeBackupConfigs,
  volumeBackups,
} from "@noddle/db/schema";
import {
  deleteVolumeBackupRunSchema,
  listVolumeBackupsSchema,
  volumeBackupRequestSchema,
  volumeRestoreRequestSchema,
} from "@noddle/shared/validation/volume-backup";
import { createServerFn } from "@tanstack/react-start";
import { and, desc, eq } from "drizzle-orm";

import { db } from "@/lib/db.server";
import { env } from "@/lib/env.server";
import { runGuarded } from "@/lib/permission.server";
import { enqueueDeploy } from "@/lib/queue.server";
import { requireSession } from "@/lib/session.server";

export interface VolumeBackupRow {
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

export const triggerVolumeBackup = createServerFn({ method: "POST" })
  .validator(volumeBackupRequestSchema)
  .handler(async ({ data }): Promise<{ volumeBackupId: string }> => {
    const guarded = await runGuarded({
      load: () =>
        db.query.volumeBackupConfigs.findFirst({
          where: eq(volumeBackupConfigs.id, data.configId),
          with: { service: true },
        }),
      notFoundMessage: "volume backup config not found",
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
    return { volumeBackupId: guarded.volumeBackupId };
  });

export const deleteVolumeBackup = createServerFn({ method: "POST" })
  .validator(deleteVolumeBackupRunSchema)
  .handler(async ({ data }): Promise<{ ok: true }> =>
    runGuarded({
      load: () =>
        db.query.volumeBackups.findFirst({
          where: eq(volumeBackups.id, data.backupId),
        }),
      notFoundMessage: "volume backup not found",
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

        await db.delete(volumeBackups).where(eq(volumeBackups.id, backup.id));
        return { ok: true as const };
      },
      target: ({ row }) => ({ id: row.id, name: row.objectKey }),
    })
  );

export const triggerVolumeRestore = createServerFn({ method: "POST" })
  .validator(volumeRestoreRequestSchema)
  .handler(async ({ data }): Promise<{ queued: true }> =>
    runGuarded({
      confirmName: { expected: (row) => row.name, typed: data.confirmName },
      load: () =>
        db.query.services.findFirst({
          where: eq(services.id, data.serviceId),
        }),
      notFoundMessage: "service not found",
      permission: { action: "restore", resource: "backup" },
      run: async ({ row: service }) => {
        if (data.backupId) {
          const backup = await db.query.volumeBackups.findFirst({
            where: eq(volumeBackups.id, data.backupId),
          });
          if (!backup || backup.serviceId !== service.id) {
            throw new Error("volume backup not found for this service");
          }
          if (backup.status !== "completed") {
            throw new Error(
              "only a completed volume backup can be restored — this one is not"
            );
          }
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
      target: ({ row }) => ({ id: row.id, name: row.name }),
    })
  );
