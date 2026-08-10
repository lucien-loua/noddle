import { databases } from "@noddle/db/schema";
import {
  databaseLifecycleRequestSchema,
  deleteDatabaseSchema,
  rebuildDatabaseSchema,
} from "@noddle/shared/validation";
import { createServerFn } from "@tanstack/react-start";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db.server";
import { requirePermission } from "@/lib/permission.server";
import { enqueueDeploy } from "@/lib/queue.server";

export const deleteDatabase = createServerFn({ method: "POST" })
  .validator(deleteDatabaseSchema)
  .handler(async ({ data }): Promise<{ ok: true }> => {
    await requirePermission({ action: "delete", resource: "database" });

    const database = await db.query.databases.findFirst({
      where: eq(databases.id, data.databaseId),
    });
    if (!database) {
      throw new Error("database not found");
    }
    if (data.confirmName !== database.name) {
      throw new Error(
        `the name you typed does not match "${database.name}" — deletion cancelled`
      );
    }

    await db
      .update(databases)
      .set({ status: "deleting" })
      .where(eq(databases.id, database.id));
    await enqueueDeploy({ databaseId: database.id, kind: "delete-database" });
    return { ok: true };
  });

export const rebuildDatabase = createServerFn({ method: "POST" })
  .validator(rebuildDatabaseSchema)
  .handler(async ({ data }): Promise<{ queued: true }> => {
    await requirePermission({ action: "delete", resource: "database" });

    const database = await db.query.databases.findFirst({
      where: eq(databases.id, data.databaseId),
    });
    if (!database) {
      throw new Error("database not found");
    }
    if (data.confirmName !== database.name) {
      throw new Error(
        `the name you typed does not match "${database.name}" — rebuild cancelled`
      );
    }

    await db
      .update(databases)
      .set({ status: "deploying" })
      .where(eq(databases.id, database.id));
    await enqueueDeploy({ databaseId: database.id, kind: "rebuild-database" });
    return { queued: true };
  });

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
