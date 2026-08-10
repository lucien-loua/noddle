import { databases } from "@noddle/db/schema";
import {
  changeDatabasePasswordSchema,
  databaseExternalPortSchema,
  databaseResourcesSchema,
} from "@noddle/shared/validation";
import { createServerFn } from "@tanstack/react-start";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db.server";
import { requirePermission } from "@/lib/permission.server";
import { enqueueDeploy } from "@/lib/queue.server";

export const setDatabaseExternalPort = createServerFn({ method: "POST" })
  .validator(databaseExternalPortSchema)
  .handler(async ({ data }): Promise<{ queued: true }> => {
    await requirePermission({ action: "create", resource: "database" });

    const database = await db.query.databases.findFirst({
      where: eq(databases.id, data.databaseId),
    });
    if (!database) {
      throw new Error("database not found");
    }

    await db
      .update(databases)
      .set({ externalPort: data.externalPort })
      .where(eq(databases.id, database.id));

    await enqueueDeploy({
      databaseId: database.id,
      kind: "provision-database",
    });
    return { queued: true };
  });

export const setDatabaseResources = createServerFn({ method: "POST" })
  .validator(databaseResourcesSchema)
  .handler(async ({ data }): Promise<{ queued: true }> => {
    await requirePermission({ action: "create", resource: "database" });

    if (
      data.memoryReservationBytes !== null &&
      data.memoryLimitBytes !== null &&
      data.memoryReservationBytes > data.memoryLimitBytes
    ) {
      throw new Error("the memory reservation cannot exceed the memory limit");
    }

    if (
      data.cpuReservationNanos !== null &&
      data.cpuLimitNanos !== null &&
      data.cpuReservationNanos > data.cpuLimitNanos
    ) {
      throw new Error("the CPU reservation cannot exceed the CPU limit");
    }

    const database = await db.query.databases.findFirst({
      where: eq(databases.id, data.databaseId),
    });
    if (!database) {
      throw new Error("database not found");
    }

    await db
      .update(databases)
      .set({
        cpuLimitNanos: data.cpuLimitNanos,
        cpuReservationNanos: data.cpuReservationNanos,
        memoryLimitBytes: data.memoryLimitBytes,
        memoryReservationBytes: data.memoryReservationBytes,
      })
      .where(eq(databases.id, database.id));

    await enqueueDeploy({
      databaseId: database.id,
      kind: "provision-database",
    });
    return { queued: true };
  });

export const changeDatabasePassword = createServerFn({ method: "POST" })
  .validator(changeDatabasePasswordSchema)
  .handler(async ({ data }): Promise<{ queued: true }> => {
    await requirePermission({ action: "create", resource: "database" });

    const database = await db.query.databases.findFirst({
      where: eq(databases.id, data.databaseId),
    });
    if (!database) {
      throw new Error("database not found");
    }
    if (database.status !== "running") {
      throw new Error("the database must be running to change its password");
    }

    await enqueueDeploy({
      databaseId: database.id,
      kind: "change-database-password",
      password: data.password,
    });
    return { queued: true };
  });
