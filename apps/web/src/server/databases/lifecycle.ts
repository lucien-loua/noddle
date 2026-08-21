import { databases } from "@noddle/db/schema";
import { markDeleting, markDeploying } from "@noddle/shared/lifecycle";
import {
  databaseLifecycleRequestSchema,
  deleteDatabaseSchema,
  rebuildDatabaseSchema,
} from "@noddle/shared/validation/database";
import { renameDatabaseSchema } from "@noddle/shared/validation/service";
import { createServerFn } from "@tanstack/react-start";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db.server";
import { runGuarded } from "@/lib/permission.server";
import { enqueueDeploy } from "@/lib/queue.server";

/**
 * Rename what a human reads. The IDENTITY is untouched.
 *
 * `name` stays put: it is what the typed delete confirmation is checked
 * against, and what the unique index covers. Nothing derives from
 * `displayName`, which is the whole point of it being a separate column.
 */
export const renameDatabase = createServerFn({ method: "POST" })
  .validator(renameDatabaseSchema)
  .handler(async ({ data }): Promise<{ ok: true }> =>
    runGuarded({
      load: () =>
        db.query.databases.findFirst({
          where: eq(databases.id, data.databaseId),
        }),
      notFoundMessage: "database not found",
      permission: { action: "create", resource: "database" },
      run: async ({ row }) => {
        await db
          .update(databases)
          // Empty means CLEAR, so it reads as its identity again.
          .set({ displayName: data.displayName || null })
          .where(eq(databases.id, row.id));
        return { ok: true as const };
      },
      // The name recorded is the one BEFORE the rename.
      target: ({ row }) => ({ id: row.id, name: row.name }),
    })
  );

export const deleteDatabase = createServerFn({ method: "POST" })
  .validator(deleteDatabaseSchema)
  .handler(async ({ data }): Promise<{ ok: true }> =>
    runGuarded({
      confirmName: {
        expected: (row) => row.name,
        typed: data.confirmName,
      },
      load: () =>
        db.query.databases.findFirst({
          where: eq(databases.id, data.databaseId),
        }),
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
      target: ({ row }) => ({ id: row.id, name: row.name }),
    })
  );

export const rebuildDatabase = createServerFn({ method: "POST" })
  .validator(rebuildDatabaseSchema)
  .handler(async ({ data }): Promise<{ queued: true }> =>
    runGuarded({
      confirmName: {
        expected: (row) => row.name,
        typed: data.confirmName,
      },
      load: () =>
        db.query.databases.findFirst({
          where: eq(databases.id, data.databaseId),
        }),
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
      target: ({ row }) => ({ id: row.id, name: row.name }),
    })
  );

export const triggerDatabaseLifecycle = createServerFn({ method: "POST" })
  .validator(databaseLifecycleRequestSchema)
  .handler(async ({ data }): Promise<{ queued: true }> =>
    // Loaded rather than enqueued blind: "operate · database" with no
    // object says nothing a month later, and a SELECT is cheap.
    runGuarded({
      load: () =>
        db.query.databases.findFirst({
          where: eq(databases.id, data.databaseId),
        }),
      notFoundMessage: "database not found",
      permission: { action: "operate", resource: "database" },
      run: async ({ row }) => {
        await enqueueDeploy({
          action: data.action,
          databaseId: row.id,
          kind: "database-lifecycle",
        });
        return { queued: true as const };
      },
      target: ({ row }) => ({ id: row.id, name: row.name }),
    })
  );
