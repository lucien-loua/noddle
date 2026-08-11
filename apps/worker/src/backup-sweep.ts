import {
  buildBackupInsert,
  resolveDestination,
  resolveDestinationRow,
} from "@noddle/backup";
import { deleteObject } from "@noddle/backup-store";
import { backupConfigs, backups } from "@noddle/db/schema";
import { Cron } from "croner";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { DeployContext } from "#deploy";

export interface BackupSweepResult {
  /** Objects pruned under retention. */
  pruned: string[];
  /** Backups queued by this sweep. */
  queued: string[];
}

/**
 * A config is due when its cron's previous fire is at or after the last
 * successful run of THAT config (or there has never been one).
 *
 * Evaluated every 5 minutes by the worker repeatable job. "Successful", not
 * "attempted": a broken database must keep retrying.
 */
function isConfigDue(
  schedule: string,
  lastCompletedAt: Date | null,
  now: Date
): boolean {
  let cron: Cron;
  try {
    cron = new Cron(schedule, { timezone: "UTC" });
  } catch {
    return false;
  }
  const [previous] = cron.previousRuns(1, now);
  if (!previous) {
    return false;
  }
  if (!lastCompletedAt) {
    return true;
  }
  return previous.getTime() > lastCompletedAt.getTime();
}

export async function sweepBackups(
  ctx: DeployContext,
  enqueue: (backupId: string) => Promise<unknown>
): Promise<BackupSweepResult> {
  const result: BackupSweepResult = { pruned: [], queued: [] };
  const now = new Date();

  const configs = await ctx.db.query.backupConfigs.findMany({
    where: eq(backupConfigs.enabled, true),
    with: { database: true },
  });

  for (const config of configs) {
    if (config.database.status !== "running") {
      continue;
    }

    // biome-ignore lint/performance/noAwaitInLoops: one config at a time
    const inFlight = await ctx.db.query.backups.findFirst({
      where: and(
        eq(backups.configId, config.id),
        inArray(backups.status, ["queued", "running"])
      ),
    });
    if (inFlight) {
      continue;
    }

    const last = await ctx.db.query.backups.findFirst({
      orderBy: desc(backups.createdAt),
      where: and(
        eq(backups.configId, config.id),
        eq(backups.status, "completed")
      ),
    });

    if (!isConfigDue(config.schedule, last?.createdAt ?? null, now)) {
      continue;
    }

    let resolved: Awaited<ReturnType<typeof resolveDestinationRow>>;
    try {
      resolved = await resolveDestinationRow(ctx.db, config.destinationId);
    } catch {
      continue;
    }

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
    if (created) {
      await enqueue(created.id);
      result.queued.push(created.id);
    }
  }

  return result;
}

/**
 * Prunes successful runs of a config beyond `keepLatestCount`.
 *
 * Called AFTER a successful backup. `null` keepLatestCount = keep all.
 */
export async function pruneBackups(
  ctx: DeployContext,
  opts: { configId: string | null; databaseId: string }
): Promise<string[]> {
  if (!opts.configId) {
    return [];
  }

  const config = await ctx.db.query.backupConfigs.findFirst({
    where: eq(backupConfigs.id, opts.configId),
  });
  if (!config?.keepLatestCount) {
    return [];
  }

  const kept = await ctx.db.query.backups.findMany({
    orderBy: desc(backups.createdAt),
    where: and(
      eq(backups.configId, opts.configId),
      eq(backups.status, "completed")
    ),
  });
  const excess = kept.slice(config.keepLatestCount);
  if (excess.length === 0) {
    return [];
  }

  const cache = new Map<
    string,
    Awaited<ReturnType<typeof resolveDestination>>
  >();
  const removed: string[] = [];

  for (const backup of excess) {
    try {
      const key = backup.destinationId ?? "";
      let resolved = cache.get(key);
      if (!resolved) {
        // biome-ignore lint/performance/noAwaitInLoops: cached resolution
        resolved = await resolveDestination(
          ctx.db,
          ctx.appKey,
          backup.destinationId
        );
        cache.set(key, resolved);
      }
      await deleteObject(resolved.destination, backup.objectKey);
    } catch {
      // Object may already be gone; still drop the row.
    }
    await ctx.db.delete(backups).where(eq(backups.id, backup.id));
    removed.push(backup.objectKey);
  }

  return removed;
}
