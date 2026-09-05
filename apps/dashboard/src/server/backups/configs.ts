import { backupConfigs } from "@noddle/db/schema";
import {
  backupConfigIdSchema,
  createBackupConfigSchema,
  updateBackupConfigSchema,
} from "@noddle/shared/validation/backup";
import { createServerFn } from "@tanstack/react-start";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db.server";
import { guarded } from "@/lib/guarded.server";
import { runGuarded } from "@/lib/permission.server";
import { requireSession } from "@/lib/session.server";
import { assertDestinationExists } from "@/server/backups/shared";

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

export const listBackupConfigs = createServerFn({ method: "GET" })
  .validator(z.object({ databaseId: z.uuid("Choose a database.") }))
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
    const outcome = await runGuarded({
      ...guarded.database(data.databaseId),
      permission: { action: "create", resource: "backup" },
      run: async ({ row: database }) => {
        await assertDestinationExists(data.destinationId);

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
        return { configId: created.id, name: database.name };
      },
      target: ({ result }) => ({ id: result.configId, name: result.name }),
    });
    return { configId: outcome.configId };
  });

export const updateBackupConfig = createServerFn({ method: "POST" })
  .validator(updateBackupConfigSchema)
  .handler(async ({ data }): Promise<{ saved: true }> =>
    runGuarded({
      ...guarded.backupConfig(data.configId),
      permission: { action: "create", resource: "backup" },
      run: async ({ row: existing }) => {
        await assertDestinationExists(data.destinationId);

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
          .where(eq(backupConfigs.id, existing.id));
        return { saved: true };
      },
      target: ({ row }) => ({ id: row.id, name: row.databaseName }),
    })
  );

export const deleteBackupConfig = createServerFn({ method: "POST" })
  .validator(backupConfigIdSchema)
  .handler(async ({ data }): Promise<{ ok: true }> =>
    runGuarded({
      ...guarded.backupConfig(data.configId),
      permission: { action: "create", resource: "backup" },
      run: async ({ row }) => {
        await db.delete(backupConfigs).where(eq(backupConfigs.id, row.id));
        return { ok: true };
      },
      target: ({ row }) => ({ id: row.id, name: row.databaseName }),
    })
  );
