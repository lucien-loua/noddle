import { buildBackupInsert } from "@noddle/backup";
import { restoreSpecFor } from "@noddle/backup/restore-spec";
import { decryptSecret, secretContext } from "@noddle/crypto";
import { backups, databases } from '@noddle/db/schema';
import type { servers } from '@noddle/db/schema';
import { and, eq } from "drizzle-orm";

import { runBackup } from "#backup";
import { runRestorePipeline } from '#backup-run/restore-pipeline';
import type { RestoreSubject } from '#backup-run/restore-pipeline';
import { assertSafeIdentifier, findDatabaseContainer } from "#database-runtime";
import { withDeployClients } from "#job-run";
import type { DeployContext } from "#runtime-context";

export interface RestoreRequest {
  backupId?: string;
  databaseId: string;
  destinationId?: string;
  objectKey?: string;
}

type DatabaseRow = NonNullable<
  Awaited<ReturnType<DeployContext["db"]["query"]["databases"]["findFirst"]>>
> & {
  server: typeof servers.$inferSelect;
};

interface DatabaseRestoreLoaded {
  database: DatabaseRow;
  password: string;
  request: RestoreRequest;
}

async function resolveRestoreSource(
  ctx: DeployContext,
  req: RestoreRequest
): Promise<{ destinationId: string | null; objectKey: string }> {
  if (req.backupId) {
    const backup = await ctx.db.query.backups.findFirst({
      where: and(
        eq(backups.id, req.backupId),
        eq(backups.databaseId, req.databaseId)
      ),
    });
    if (!backup) {
      throw new Error(
        "backup not found for this database — cross-database restore refused"
      );
    }
    if (backup.status !== "completed") {
      throw new Error(
        `backup is in status "${backup.status}": only a completed backup can be restored`
      );
    }
    const { destinationId, objectKey } = backup;
    return { destinationId, objectKey };
  }

  if (req.destinationId && req.objectKey) {
    const { destinationId, objectKey } = req;
    return { destinationId, objectKey };
  }

  throw new Error("restore requires backupId, or destinationId and objectKey");
}

async function applyDatabaseRestore(
  ctx: DeployContext,
  loaded: DatabaseRestoreLoaded,
  body: NodeJS.ReadableStream
): Promise<void> {
  const { database, password } = loaded;

  await withDeployClients(
    ctx,
    database.server,
    async ({ buildClient, managerDocker }) => {
      const containerId = await findDatabaseContainer(
        buildClient,
        database.swarmName
      );
      const databaseName =
        database.databaseName ?? database.rootUser ?? database.name;
      assertSafeIdentifier(databaseName, "database name");
      if (database.rootUser) {
        assertSafeIdentifier(database.rootUser, "database user");
      }

      await restoreSpecFor(database.engine).apply({
        body,
        buildClient,
        containerId,
        database,
        managerDocker,
        password,
      });
    }
  );
}

const databaseRestoreSubject: RestoreSubject<
  RestoreRequest,
  DatabaseRestoreLoaded
> = {
  apply: applyDatabaseRestore,
  load: async (ctx, request) => {
    const database = await ctx.db.query.databases.findFirst({
      where: eq(databases.id, request.databaseId),
      with: { server: true },
    });
    if (!database) {
      throw new Error(`database not found: ${request.databaseId}`);
    }
    const password = decryptSecret(
      database.rootPasswordEncrypted,
      ctx.appKey,
      secretContext.databasePassword(database.id)
    );
    return { database, password, request };
  },
  missingObjectTarget: "database",
  resolveSource: async (ctx, request) =>
    await resolveRestoreSource(ctx, request),
  safetyBackup: async (ctx, loaded, resolved) => {
    const [safety] = await ctx.db
      .insert(backups)
      .values(
        buildBackupInsert({
          database: loaded.database,
          kind: "pre_restore",
          resolved: {
            id: resolved.id,
            prefix: resolved.destination.prefix,
          },
        })
      )
      .returning();
    if (!safety) {
      throw new Error("could not create the safety backup");
    }
    await runBackup(ctx, safety.id);
  },
};

export async function runRestore(
  ctx: DeployContext,
  req: RestoreRequest
): Promise<void> {
  await runRestorePipeline(databaseRestoreSubject, ctx, req);
}
