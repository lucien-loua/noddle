import {
  s3Destinations,
  services,
  volumeBackupConfigs,
} from "@noddle/db/schema";
import {
  createVolumeBackupConfigSchema,
  updateVolumeBackupConfigSchema,
  volumeBackupConfigIdSchema,
} from "@noddle/shared/validation/volume-backup";
import { createServerFn } from "@tanstack/react-start";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db.server";
import { runGuarded } from "@/lib/permission.server";
import { requireSession } from "@/lib/session.server";

export interface VolumeBackupConfigRow {
  createdAt: string;
  destinationId: string;
  destinationName: string;
  enabled: boolean;
  id: string;
  keepLatestCount: number | null;
  mountPath: string | null;
  prefix: string;
  schedule: string;
  serviceId: string;
  updatedAt: string;
  volumeName: string;
}

function normalizeMountPath(path: string | undefined): string | null {
  const trimmed = path?.trim() ?? "";
  if (trimmed === "" || trimmed === "/") {
    return null;
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

async function resolveMountPath(
  serviceId: string,
  volumeName: string,
  mountPathFromForm?: string
): Promise<string | null> {
  const fromForm = normalizeMountPath(mountPathFromForm);
  if (fromForm) {
    return fromForm;
  }
  try {
    const { loadServiceVolumeMounts } = await import("./volumes.server");
    const mounts = await loadServiceVolumeMounts(serviceId);
    const mount = mounts.find((m) => m.volumeName === volumeName);
    return normalizeMountPath(mount?.mountPath);
  } catch {
    return null;
  }
}

export const listVolumeBackupConfigs = createServerFn({ method: "GET" })
  .validator(z.object({ serviceId: z.uuid() }))
  .handler(async ({ data }): Promise<VolumeBackupConfigRow[]> => {
    await requireSession();
    const rows = await db.query.volumeBackupConfigs.findMany({
      orderBy: desc(volumeBackupConfigs.createdAt),
      where: eq(volumeBackupConfigs.serviceId, data.serviceId),
      with: { destination: true },
    });
    return rows.map((row) => ({
      createdAt: row.createdAt.toISOString(),
      destinationId: row.destinationId,
      destinationName: row.destination.name,
      enabled: row.enabled,
      id: row.id,
      keepLatestCount: row.keepLatestCount,
      mountPath: row.mountPath,
      prefix: row.prefix,
      schedule: row.schedule,
      serviceId: row.serviceId,
      updatedAt: row.updatedAt.toISOString(),
      volumeName: row.volumeName,
    }));
  });

export const createVolumeBackupConfig = createServerFn({ method: "POST" })
  .validator(createVolumeBackupConfigSchema)
  .handler(async ({ data }): Promise<{ configId: string }> => {
    const guarded = await runGuarded({
      load: () =>
        db.query.services.findFirst({
          where: eq(services.id, data.serviceId),
        }),
      notFoundMessage: "service not found",
      permission: { action: "create", resource: "backup" },
      run: async ({ row: service }) => {
        const destination = await db.query.s3Destinations.findFirst({
          where: eq(s3Destinations.id, data.destinationId),
        });
        if (!destination) {
          throw new Error("S3 destination not found");
        }

        const [created] = await db
          .insert(volumeBackupConfigs)
          .values({
            destinationId: data.destinationId,
            enabled: data.enabled,
            keepLatestCount: data.keepLatestCount,
            mountPath: await resolveMountPath(
              service.id,
              data.volumeName,
              data.mountPath
            ),
            prefix: data.prefix,
            schedule: data.schedule.trim(),
            serviceId: service.id,
            volumeName: data.volumeName,
          })
          .returning();
        if (!created) {
          throw new Error("could not create volume backup config");
        }
        return { configId: created.id, name: service.name };
      },
      target: ({ result }) => ({ id: result.configId, name: result.name }),
    });
    return { configId: guarded.configId };
  });

export const updateVolumeBackupConfig = createServerFn({ method: "POST" })
  .validator(updateVolumeBackupConfigSchema)
  .handler(async ({ data }): Promise<{ saved: true }> =>
    runGuarded({
      load: () =>
        db.query.volumeBackupConfigs.findFirst({
          where: eq(volumeBackupConfigs.id, data.configId),
          with: { service: true },
        }),
      notFoundMessage: "volume backup config not found",
      permission: { action: "create", resource: "backup" },
      run: async ({ row: existing }) => {
        const destination = await db.query.s3Destinations.findFirst({
          where: eq(s3Destinations.id, data.destinationId),
        });
        if (!destination) {
          throw new Error("S3 destination not found");
        }

        await db
          .update(volumeBackupConfigs)
          .set({
            destinationId: data.destinationId,
            enabled: data.enabled,
            keepLatestCount: data.keepLatestCount,
            mountPath: await resolveMountPath(
              existing.serviceId,
              data.volumeName,
              data.mountPath
            ),
            prefix: data.prefix,
            schedule: data.schedule.trim(),
            updatedAt: new Date(),
            volumeName: data.volumeName,
          })
          .where(eq(volumeBackupConfigs.id, existing.id));
        return { saved: true as const };
      },
      target: ({ row }) => ({
        id: row.id,
        name: row.service.name,
      }),
    })
  );

export const deleteVolumeBackupConfig = createServerFn({ method: "POST" })
  .validator(volumeBackupConfigIdSchema)
  .handler(async ({ data }): Promise<{ ok: true }> =>
    runGuarded({
      load: () =>
        db.query.volumeBackupConfigs.findFirst({
          where: eq(volumeBackupConfigs.id, data.configId),
          with: { service: true },
        }),
      notFoundMessage: "volume backup config not found",
      permission: { action: "create", resource: "backup" },
      run: async ({ row }) => {
        await db
          .delete(volumeBackupConfigs)
          .where(eq(volumeBackupConfigs.id, row.id));
        return { ok: true as const };
      },
      target: ({ row }) => ({ id: row.id, name: row.service.name }),
    })
  );
