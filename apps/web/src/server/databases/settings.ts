import { DEFAULT_DATABASE_VOLUME_PATH } from "@noddle/database-spec";
import { databases } from "@noddle/db/schema";
import {
  addDatabaseMountSchema,
  changeDatabasePasswordSchema,
  databaseConfigurationSchema,
  databaseExternalPortSchema,
  databaseReplicasSchema,
  databaseResourcesSchema,
  databaseVolumePathSchema,
  deleteDatabaseMountSchema,
  setDatabaseSwarmSettingsSchema,
  updateDatabaseMountSchema,
} from "@noddle/shared/validation/database";
import { createServerFn } from "@tanstack/react-start";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db.server";
import { queueDatabaseProvision } from "@/lib/deploy-queue.server";
import { runGuarded } from "@/lib/permission.server";
import { enqueueDeploy } from "@/lib/queue.server";

/** The row every setting acts on. `runGuarded` owns the not-found case. */
function loadDatabase(databaseId: string) {
  return db.query.databases.findFirst({
    where: eq(databases.id, databaseId),
  });
}

function assertMountTargetAllowed(
  target: string,
  primaryVolumePath: string | null,
  otherTargets: string[]
): void {
  if (target.startsWith("/run/secrets")) {
    throw new Error("that mount path is reserved for secrets");
  }
  if (primaryVolumePath !== null && target === primaryVolumePath) {
    throw new Error("that mount path is reserved for the primary data volume");
  }
  if (otherTargets.includes(target)) {
    throw new Error("another mount already uses that path");
  }
}

export const setDatabaseExternalPort = createServerFn({ method: "POST" })
  .validator(databaseExternalPortSchema)
  .handler(async ({ data }): Promise<{ queued: true }> =>
    runGuarded({
      load: () => loadDatabase(data.databaseId),
      notFoundMessage: "database not found",
      permission: { action: "create", resource: "database" },
      run: async ({ row: database }) => {
        await db
          .update(databases)
          .set({ externalPort: data.externalPort })
          .where(eq(databases.id, database.id));

        await queueDatabaseProvision(database.id);
        return { queued: true as const };
      },
      target: ({ row }) => ({ id: row.id, name: row.name }),
    })
  );

export const setDatabaseResources = createServerFn({ method: "POST" })
  .validator(databaseResourcesSchema)
  .handler(async ({ data }): Promise<{ queued: true }> =>
    runGuarded({
      load: () => loadDatabase(data.databaseId),
      notFoundMessage: "database not found",
      permission: { action: "create", resource: "database" },
      run: async ({ row: database }) => {
        if (
          data.memoryReservationBytes !== null &&
          data.memoryLimitBytes !== null &&
          data.memoryReservationBytes > data.memoryLimitBytes
        ) {
          throw new Error(
            "the memory reservation cannot exceed the memory limit"
          );
        }

        if (
          data.cpuReservationNanos !== null &&
          data.cpuLimitNanos !== null &&
          data.cpuReservationNanos > data.cpuLimitNanos
        ) {
          throw new Error("the CPU reservation cannot exceed the CPU limit");
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

        await queueDatabaseProvision(database.id);
        return { queued: true as const };
      },
      target: ({ row }) => ({ id: row.id, name: row.name }),
    })
  );

export const setDatabaseConfiguration = createServerFn({ method: "POST" })
  .validator(databaseConfigurationSchema)
  .handler(async ({ data }): Promise<{ queued: true }> =>
    runGuarded({
      load: () => loadDatabase(data.databaseId),
      notFoundMessage: "database not found",
      permission: { action: "create", resource: "database" },
      run: async ({ row: database }) => {
        await db
          .update(databases)
          .set({ image: data.image })
          .where(eq(databases.id, database.id));

        await queueDatabaseProvision(database.id);
        return { queued: true as const };
      },
      target: ({ row }) => ({ id: row.id, name: row.name }),
    })
  );

export const setDatabaseReplicas = createServerFn({ method: "POST" })
  .validator(databaseReplicasSchema)
  .handler(async ({ data }): Promise<{ queued: true }> =>
    runGuarded({
      load: () => loadDatabase(data.databaseId),
      notFoundMessage: "database not found",
      permission: { action: "create", resource: "database" },
      run: async ({ row: database }) => {
        await db
          .update(databases)
          .set({ replicas: data.replicas })
          .where(eq(databases.id, database.id));

        await queueDatabaseProvision(database.id);
        return { queued: true as const };
      },
      target: ({ row }) => ({ id: row.id, name: row.name }),
    })
  );

export const setDatabaseSwarmSettings = createServerFn({ method: "POST" })
  .validator(setDatabaseSwarmSettingsSchema)
  .handler(async ({ data }): Promise<{ queued: true }> =>
    runGuarded({
      load: () => loadDatabase(data.databaseId),
      notFoundMessage: "database not found",
      permission: { action: "create", resource: "database" },
      run: async ({ row: database }) => {
        const previous = database.swarmSettings ?? {};
        const next = { ...previous };

        for (const [key, value] of Object.entries(data.swarmSettings)) {
          if (value === null) {
            delete next[key as keyof typeof next];
          } else if (value !== undefined) {
            // biome-ignore lint/suspicious/noExplicitAny: keyed merge of typed slices
            (next as any)[key] = value;
          }
        }

        const cleared = Object.keys(next).length === 0 ? null : next;

        await db
          .update(databases)
          .set({ swarmSettings: cleared })
          .where(eq(databases.id, database.id));

        await queueDatabaseProvision(database.id);
        return { queued: true as const };
      },
      target: ({ row }) => ({ id: row.id, name: row.name }),
    })
  );

export const setDatabaseVolumePath = createServerFn({ method: "POST" })
  .validator(databaseVolumePathSchema)
  .handler(async ({ data }): Promise<{ queued: true }> =>
    runGuarded({
      load: () => loadDatabase(data.databaseId),
      notFoundMessage: "database not found",
      permission: { action: "create", resource: "database" },
      run: async ({ row: database }) => {
        if (data.volumePath) {
          assertMountTargetAllowed(
            data.volumePath,
            null,
            database.extraMounts.map((m) => m.target)
          );
        }

        await db
          .update(databases)
          .set({ volumePath: data.volumePath })
          .where(eq(databases.id, database.id));

        await queueDatabaseProvision(database.id);
        return { queued: true as const };
      },
      target: ({ row }) => ({ id: row.id, name: row.name }),
    })
  );

export const addDatabaseMount = createServerFn({ method: "POST" })
  .validator(addDatabaseMountSchema)
  .handler(async ({ data }): Promise<{ queued: true }> =>
    runGuarded({
      load: () => loadDatabase(data.databaseId),
      notFoundMessage: "database not found",
      permission: { action: "create", resource: "database" },
      run: async ({ row: database }) => {
        const primaryPath =
          database.volumePath ?? DEFAULT_DATABASE_VOLUME_PATH[database.engine];
        assertMountTargetAllowed(
          data.target,
          primaryPath,
          database.extraMounts.map((m) => m.target)
        );

        const mount = {
          id: crypto.randomUUID(),
          source: data.source,
          target: data.target,
          type: data.type,
        };

        await db
          .update(databases)
          .set({ extraMounts: [...database.extraMounts, mount] })
          .where(eq(databases.id, database.id));

        await queueDatabaseProvision(database.id);
        return { queued: true as const };
      },
      target: ({ row }) => ({ id: row.id, name: row.name }),
    })
  );

export const updateDatabaseMount = createServerFn({ method: "POST" })
  .validator(updateDatabaseMountSchema)
  .handler(async ({ data }): Promise<{ queued: true }> =>
    runGuarded({
      load: () => loadDatabase(data.databaseId),
      notFoundMessage: "database not found",
      permission: { action: "create", resource: "database" },
      run: async ({ row: database }) => {
        const existing = database.extraMounts.find(
          (m) => m.id === data.mountId
        );
        if (!existing) {
          throw new Error("mount not found");
        }

        const primaryPath =
          database.volumePath ?? DEFAULT_DATABASE_VOLUME_PATH[database.engine];
        assertMountTargetAllowed(
          data.target,
          primaryPath,
          database.extraMounts
            .filter((m) => m.id !== data.mountId)
            .map((m) => m.target)
        );

        const next = database.extraMounts.map((m) =>
          m.id === data.mountId
            ? {
                id: m.id,
                source: data.source,
                target: data.target,
                type: data.type,
              }
            : m
        );

        await db
          .update(databases)
          .set({ extraMounts: next })
          .where(eq(databases.id, database.id));

        await queueDatabaseProvision(database.id);
        return { queued: true as const };
      },
      target: ({ row }) => ({ id: row.id, name: row.name }),
    })
  );

export const deleteDatabaseMount = createServerFn({ method: "POST" })
  .validator(deleteDatabaseMountSchema)
  .handler(async ({ data }): Promise<{ queued: true }> =>
    runGuarded({
      load: () => loadDatabase(data.databaseId),
      notFoundMessage: "database not found",
      permission: { action: "create", resource: "database" },
      run: async ({ row: database }) => {
        const next = database.extraMounts.filter((m) => m.id !== data.mountId);
        if (next.length === database.extraMounts.length) {
          throw new Error("mount not found");
        }

        await db
          .update(databases)
          .set({ extraMounts: next })
          .where(eq(databases.id, database.id));

        await queueDatabaseProvision(database.id);
        return { queued: true as const };
      },
      target: ({ row }) => ({ id: row.id, name: row.name }),
    })
  );

export const changeDatabasePassword = createServerFn({ method: "POST" })
  .validator(changeDatabasePasswordSchema)
  .handler(async ({ data }): Promise<{ queued: true }> =>
    runGuarded({
      load: () => loadDatabase(data.databaseId),
      notFoundMessage: "database not found",
      permission: { action: "create", resource: "database" },
      run: async ({ row: database }) => {
        if (database.status !== "running") {
          throw new Error(
            "the database must be running to change its password"
          );
        }

        await enqueueDeploy({
          databaseId: database.id,
          kind: "change-database-password",
          password: data.password,
        });
        return { queued: true as const };
      },
      target: ({ row }) => ({ id: row.id, name: row.name }),
    })
  );
