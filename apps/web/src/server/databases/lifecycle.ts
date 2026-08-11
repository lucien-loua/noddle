import { databases } from "@noddle/db/schema";
import { markDeleting, markDeploying } from "@noddle/shared/lifecycle";
import {
  databaseLifecycleRequestSchema,
  deleteDatabaseSchema,
  rebuildDatabaseSchema,
} from "@noddle/shared/validation/database";
import { createServerFn } from "@tanstack/react-start";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db.server";
import { runGuardedMutation } from "@/lib/guarded-mutation.server";
import { requirePermission } from "@/lib/permission.server";
import { enqueueDeploy } from "@/lib/queue.server";

export const deleteDatabase = createServerFn({ method: "POST" })
  .validator(deleteDatabaseSchema)
  .handler(
    async ({ data }): Promise<{ ok: true }> =>
      runGuardedMutation({
        confirmName: {
          expected: (row) => row.name,
          typed: data.confirmName,
        },
        idOf: (row) => row.id,
        load: () =>
          db.query.databases.findFirst({
            where: eq(databases.id, data.databaseId),
          }),
        nameOf: (row) => row.name,
        notFoundMessage: "database not found",
        permission: { action: "delete", resource: "database" },
        run: async ({ row }) => {
          await db
            .update(databases)
            .set(markDeleting(null))
            .where(eq(databases.id, row.id));
          await enqueueDeploy({ databaseId: row.id, kind: "delete-database" });
          return { ok: true as const };
        },
      })
  );

export const rebuildDatabase = createServerFn({ method: "POST" })
  .validator(rebuildDatabaseSchema)
  .handler(
    async ({ data }): Promise<{ queued: true }> =>
      runGuardedMutation({
        confirmName: {
          expected: (row) => row.name,
          typed: data.confirmName,
        },
        idOf: (row) => row.id,
        load: () =>
          db.query.databases.findFirst({
            where: eq(databases.id, data.databaseId),
          }),
        nameOf: (row) => row.name,
        notFoundMessage: "database not found",
        permission: { action: "delete", resource: "database" },
        run: async ({ row }) => {
          await db
            .update(databases)
            .set(markDeploying(null))
            .where(eq(databases.id, row.id));
          await enqueueDeploy({ databaseId: row.id, kind: "rebuild-database" });
          return { queued: true as const };
        },
      })
  );

export const triggerDatabaseLifecycle = createServerFn({ method: "POST" })
  .validator(databaseLifecycleRequestSchema)
  .handler(async ({ data }): Promise<{ queued: true }> => {
    await requirePermission({ action: "operate", resource: "database" });
    await enqueueDeploy({
      action: data.action,
      databaseId: data.databaseId,
      kind: "database-lifecycle",
    });
    return { queued: true };
  });
