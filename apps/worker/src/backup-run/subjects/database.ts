import { buildBackupInsert } from "@noddle/backup";
import type { BackupDestination } from "@noddle/backup-store";
import { backupConfigs, backups, type servers } from "@noddle/db/schema";
import { decryptSecret, secretContext } from "@noddle/shared/crypto";
import type { DatabaseEngine } from "@noddle/shared/database-engines";
import { execStream, quoteArg, type SshClient } from "@noddle/ssh-executor";
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
import type { DeployContext } from "#runtime-context";

type Engine = DatabaseEngine;

interface DumpSpec {
  argv: (opts: {
    containerId: string;
    databaseName: string | null;
    rootUser: string | null;
  }) => string[];
  env: (opts: {
    databaseName: string | null;
    password: string;
    rootUser: string | null;
  }) => Record<string, string>;
}

const DUMP_SPECS: Record<Engine, DumpSpec> = {
  mariadb: {
    argv: ({ containerId, databaseName, rootUser }) => [
      "docker",
      "exec",
      "-e",
      "MYSQL_PWD",
      containerId,
      "mariadb-dump",
      `--user=${rootUser ?? "root"}`,
      "--single-transaction",
      "--quick",
      databaseName ?? "",
    ],
    env: ({ password }) => ({ MYSQL_PWD: password }),
  },
  mongo: {
    argv: ({ containerId }) => [
      "docker",
      "exec",
      "-e",
      "MONGO_PWD",
      "-e",
      "MONGO_USER",
      "-e",
      "MONGO_DB",
      containerId,
      "sh",
      "-c",
      "umask 077 && printf 'password: %s\\n' \"$MONGO_PWD\" > /tmp/md.yaml && " +
        'mongodump --config=/tmp/md.yaml -u "$MONGO_USER" ' +
        '--authenticationDatabase admin -d "$MONGO_DB" ' +
        "--archive --gzip; rc=$?; rm -f /tmp/md.yaml; exit $rc",
    ],
    env: ({ databaseName, password, rootUser }) => ({
      MONGO_DB: databaseName ?? "",
      MONGO_PWD: password,
      MONGO_USER: rootUser ?? "mongo",
    }),
  },
  mysql: {
    argv: ({ containerId, databaseName, rootUser }) => [
      "docker",
      "exec",
      "-e",
      "MYSQL_PWD",
      containerId,
      "mysqldump",
      `--user=${rootUser ?? "root"}`,
      "--single-transaction",
      "--no-tablespaces",
      "--quick",
      databaseName ?? "",
    ],
    env: ({ password }) => ({ MYSQL_PWD: password }),
  },
  postgres: {
    argv: ({ containerId, databaseName, rootUser }) => [
      "docker",
      "exec",
      containerId,
      "pg_dump",
      "-Fc",
      "-U",
      rootUser ?? "postgres",
      databaseName ?? rootUser ?? "postgres",
    ],
    env: () => ({}),
  },
  redis: {
    argv: ({ containerId }) => [
      "docker",
      "exec",
      "-e",
      "REDISCLI_AUTH",
      containerId,
      "redis-cli",
      "--rdb",
      "-",
    ],
    env: ({ password }) => ({ REDISCLI_AUTH: password }),
  },
};

const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function assertSafeIdentifier(value: string, label: string): void {
  if (!SAFE_IDENTIFIER.test(value)) {
    throw new Error(
      `${label} is not a safe identifier: "${value}" — letters, digits and underscores only, not starting with a digit`
    );
  }
}

export function legacyDatabaseServiceName(name: string): string {
  return `noddle-db-${name}`;
}

export async function findDatabaseContainer(
  client: SshClient,
  serviceName: string
): Promise<string> {
  const { code, stderr, value } = await execStream(
    client,
    `docker ps --no-trunc --filter ${quoteArg(`label=com.docker.swarm.service.name=${serviceName}`)} --format ${quoteArg("{{.ID}}")}`,
    async ({ stdout }) => {
      let out = "";
      stdout.setEncoding("utf8");
      for await (const chunk of stdout) {
        out += chunk as string;
      }
      return out;
    }
  );
  if (code !== 0) {
    throw new Error(`docker ps failed (code ${code}): ${stderr}`);
  }
  const id = value
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "");
  if (!id) {
    throw new Error(
      `no running container for ${serviceName} — is the database up?`
    );
  }
  return id;
}

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
  const spec = DUMP_SPECS[database.engine];
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
