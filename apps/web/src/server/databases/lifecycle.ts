import { databases } from "@noddle/db/schema";
import { markDeleting } from "@noddle/shared/lifecycle";
import {
  databaseLifecycleRequestSchema,
  deleteDatabaseSchema,
  rebuildDatabaseSchema,
} from "@noddle/shared/validation/database";
import { renameDatabaseSchema } from "@noddle/shared/validation/service";
import { createServerFn } from "@tanstack/react-start";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db.server";
import { queueDatabaseProvision } from "@/lib/deploy-queue.server";
import { guarded, identityTarget } from "@/lib/guarded.server";
import { runGuarded } from "@/lib/permission.server";
import { enqueueDeploy } from "@/lib/queue.server";

export const renameDatabase = createServerFn({ method: "POST" })
  .validator(renameDatabaseSchema)
  .handler(async ({ data }): Promise<{ ok: true }> =>
    runGuarded({
      ...guarded.database(data.databaseId),
      permission: { action: "create", resource: "database" },
      run: async ({ row }) => {
        await db
          .update(databases)
          .set({ displayName: data.displayName || null })
          .where(eq(databases.id, row.id));
        return { ok: true as const };
      },
      target: identityTarget,
    })
  );

export const deleteDatabase = createServerFn({ method: "POST" })
  .validator(deleteDatabaseSchema)
  .handler(async ({ data }): Promise<{ ok: true }> =>
    runGuarded({
      ...guarded.database(data.databaseId),
      confirmName: {
        expected: (row) => row.name,
        typed: data.confirmName,
      },
      permission: { action: "delete", resource: "database" },
      run: async ({ row }) => {
        await db
          .update(databases)
          .set(markDeleting(null))
          .where(eq(databases.id, row.id));
        await enqueueDeploy({ databaseId: row.id, kind: "delete-database" });
        return { ok: true as const };
      },
      target: identityTarget,
    })
  );

export const rebuildDatabase = createServerFn({ method: "POST" })
  .validator(rebuildDatabaseSchema)
  .handler(async ({ data }): Promise<{ deploymentId: string }> =>
    runGuarded({
      ...guarded.database(data.databaseId),
      confirmName: {
        expected: (row) => row.name,
        typed: data.confirmName,
      },
      permission: { action: "delete", resource: "database" },
      run: ({ row }) => queueDatabaseProvision(row.id, "rebuild-database"),
      target: identityTarget,
    })
  );

export const triggerDatabaseLifecycle = createServerFn({ method: "POST" })
  .validator(databaseLifecycleRequestSchema)
  .handler(async ({ data }): Promise<{ queued: true }> =>
    runGuarded({
      ...guarded.database(data.databaseId),
      permission: { action: "operate", resource: "database" },
      run: async ({ row }) => {
        await enqueueDeploy({
          action: data.action,
          databaseId: row.id,
          kind: "database-lifecycle",
        });
        return { queued: true as const };
      },
      target: identityTarget,
    })
  );
