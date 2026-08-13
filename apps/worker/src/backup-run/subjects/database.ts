import { buildBackupInsert } from "@noddle/backup";
import { dumpSpecFor } from "@noddle/backup/dump-spec";
import type { BackupDestination } from "@noddle/backup-store";
import { decryptSecret, secretContext } from "@noddle/crypto";
import type { DatabaseEngine } from "@noddle/database-spec";
import { backupConfigs, backups, type servers } from "@noddle/db/schema";
import { quoteArg, type SshClient } from "@noddle/ssh-executor";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  type BackupRunRow,
  type BackupSubject,
  captureToS3,
} from "#backup-run/pipeline";
import type { BackupRecoverSubject } from "#backup-run/recover";
import {
  type BackupPruneSubject,
  type BackupSweepSubject,
  pruneBackupRuns,
  sweepBackupConfigs,
} from "#backup-run/sweep";
import {
  assertSafeIdentifier,
  findDatabaseContainer,
} from "#database-runtime";
import type { DeployContext } from "#runtime-context";

interface DatabaseBackupRun extends BackupRunRow {
  config?: { databaseName: string | null; destinationId: string } | null;
  database: {
    databaseName: string | null;
    engine: DatabaseEngine;
    id: string;
    name: string;
    rootPasswordEncrypted: string;
    rootUser: string | null;
    server: typeof servers.$inferSelect;
    swarmName: string;
  };
}

async function buildDumpCommand(
  ctx: DeployContext,
  client: SshClient,
  run: DatabaseBackupRun
): Promise<string> {
  const { database } = run;
  const password = decryptSecret(
    database.rootPasswordEncrypted,
    ctx.appKey,
    secretContext.databasePassword(database.id)
  );
  const spec = dumpSpecFor(database.engine);
  const dumpDatabaseName = run.config?.databaseName ?? database.databaseName;
  const containerId = await findDatabaseContainer(client, database.swarmName);

  const env = spec.env({
    databaseName: dumpDatabaseName,
    password,
    rootUser: database.rootUser,
  });
  const envPrefix = Object.entries(env)
    .map(([k, v]) => `${k}=${quoteArg(v)}`)
    .join(" ");
  if (dumpDatabaseName) {
    assertSafeIdentifier(dumpDatabaseName, "database name");
  }
  if (database.rootUser) {
    assertSafeIdentifier(database.rootUser, "database user");
  }
  const argv = spec
    .argv({
      containerId,
      databaseName: dumpDatabaseName,
      rootUser: database.rootUser,
    })
    .map(quoteArg)
    .join(" ");
  return envPrefix === "" ? argv : `${envPrefix} ${argv}`;
}

export const databaseBackupSubject: BackupSubject<DatabaseBackupRun> = {
  capture: async (ctx, client, run, destination: BackupDestination) => {
    const command = await buildDumpCommand(ctx, client, run);
    return await captureToS3(client, command, destination, run.objectKey);
  },
  incompleteMessage: (code, stderr) =>
    `the dumper exited with ${code} — backup incomplete, object deleted: ${stderr.slice(0, 500)}`,
  loadRun: async (ctx, runId) => {
    const backup = await ctx.db.query.backups.findFirst({
      where: eq(backups.id, runId),
      with: { config: true, database: { with: { server: true } } },
    });
    if (!backup) {
      return null;
    }
    return {
      ...backup,
      configDestinationId: backup.config?.destinationId ?? null,
    };
  },
  markCompleted: async (ctx, runId, sizeBytes) => {
    await ctx.db
      .update(backups)
      .set({ finishedAt: new Date(), sizeBytes, status: "completed" })
      .where(eq(backups.id, runId));
  },
  markFailed: async (ctx, runId, message) => {
    await ctx.db
      .update(backups)
      .set({
        errorMessage: message,
        finishedAt: new Date(),
        status: "failed",
      })
      .where(eq(backups.id, runId));
  },
  markRunning: async (ctx, runId, destinationId) => {
    await ctx.db
      .update(backups)
      .set({ destinationId, startedAt: new Date(), status: "running" })
      .where(eq(backups.id, runId));
  },
  notFoundMessage: (runId) => `backup not found: ${runId}`,
  notifyResource: (run) => run.database.name,
  prune: async (ctx, run) => {
    await pruneDatabaseBackups(ctx, {
      configId: run.configId,
      databaseId: run.database.id,
    });
  },
  server: (run) => run.database.server,
};

type DatabaseConfig = typeof backupConfigs.$inferSelect & {
  database: {
    engine: DatabaseEngine;
    id: string;
    name: string;
    status: string;
  };
};

export const databaseSweepSubject: BackupSweepSubject<DatabaseConfig> = {
  configDestinationId: (config) => config.destinationId,
  configId: (config) => config.id,
  configSchedule: (config) => config.schedule,
  findInFlight: async (ctx, configId) => {
    const row = await ctx.db.query.backups.findFirst({
      where: and(
        eq(backups.configId, configId),
        inArray(backups.status, ["queued", "running"])
      ),
    });
    return row !== undefined;
  },
  findLastCompletedAt: async (ctx, configId) => {
    const last = await ctx.db.query.backups.findFirst({
      orderBy: desc(backups.createdAt),
      where: and(
        eq(backups.configId, configId),
        eq(backups.status, "completed")
      ),
    });
    return last?.createdAt ?? null;
  },
  insertScheduled: async (ctx, config, resolved) => {
    const [created] = await ctx.db
      .insert(backups)
      .values(
        buildBackupInsert({
          configId: config.id,
          configPrefix: config.prefix,
          database: config.database,
          databaseName: config.databaseName,
          kind: "scheduled",
          resolved,
        })
      )
      .returning();
    return created ?? null;
  },
  isParentActive: (config) => config.database.status === "running",
  loadEnabledConfigs: async (ctx) =>
    await ctx.db.query.backupConfigs.findMany({
      where: eq(backupConfigs.enabled, true),
      with: { database: true },
    }),
};

export const databasePruneSubject: BackupPruneSubject = {
  deleteRun: async (ctx, runId) => {
    await ctx.db.delete(backups).where(eq(backups.id, runId));
  },
  findExcessRuns: async (ctx, configId, keepLatestCount) => {
    const kept = await ctx.db.query.backups.findMany({
      orderBy: desc(backups.createdAt),
      where: and(
        eq(backups.configId, configId),
        eq(backups.status, "completed")
      ),
    });
    return kept.slice(keepLatestCount);
  },
  loadKeepLatestCount: async (ctx, configId) => {
    const config = await ctx.db.query.backupConfigs.findFirst({
      where: eq(backupConfigs.id, configId),
    });
    return config?.keepLatestCount;
  },
};

export const databaseRecoverSubject: BackupRecoverSubject = {
  findRunningIds: async (ctx) => {
    const running = await ctx.db.query.backups.findMany({
      where: eq(backups.status, "running"),
    });
    return running.map((row) => row.id);
  },
  markStaleFailed: async (ctx, ids, message) => {
    await ctx.db
      .update(backups)
      .set({
        errorMessage: message,
        finishedAt: new Date(),
        status: "failed",
      })
      .where(inArray(backups.id, ids));
  },
};

export async function sweepDatabaseBackups(
  ctx: DeployContext,
  enqueue: (backupId: string) => Promise<unknown>
) {
  return await sweepBackupConfigs(databaseSweepSubject, ctx, enqueue);
}

export async function pruneDatabaseBackups(
  ctx: DeployContext,
  opts: { configId: string | null; databaseId: string }
) {
  return await pruneBackupRuns(databasePruneSubject, ctx, opts);
}

export async function recoverStaleDatabaseBackups(
  ctx: DeployContext
): Promise<number> {
  const { recoverStaleBackupRuns } = await import("#backup-run/recover");
  return await recoverStaleBackupRuns(databaseRecoverSubject, ctx);
}
