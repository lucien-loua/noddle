import {
  buildBackupInsert,
  resolveDestination,
  resolveDestinationRow,
} from "@noddle/backup";
import { deleteObject } from "@noddle/backup-store";
import { backups, databases } from "@noddle/db/schema";
import { and, desc, eq } from "drizzle-orm";
import type { DeployContext } from "#deploy";

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

const INTERVALS: Record<string, number> = {
  daily: DAY_MS,
  weekly: WEEK_MS,
};

export interface BackupSweepResult {
  /** Objects pruned under retention. */
  pruned: string[];
  /** Backups queued by this sweep. */
  queued: string[];
}

/**
 * A database is due if its last SUCCESSFUL backup is older than its
 * interval.
 *
 * "Successful", not "attempted": otherwise a broken database would stop
 * being backed up after the first failure, exactly when it's needed most.
 * The accepted trade-off is that a database that's been down for a while
 * will retry on every sweep — that's the sensible side of the compromise,
 * and the `failed` status stays visible in the history.
 */
export async function sweepBackups(
  ctx: DeployContext,
  enqueue: (backupId: string) => Promise<unknown>
): Promise<BackupSweepResult> {
  const result: BackupSweepResult = { pruned: [], queued: [] };

  const scheduled = await ctx.db.query.databases.findMany({
    where: and(eq(databases.status, "running")),
  });

  for (const database of scheduled) {
    if (database.backupSchedule === "off") {
      continue;
    }
    const interval = INTERVALS[database.backupSchedule];
    if (!interval) {
      continue;
    }

    // biome-ignore lint/performance/noAwaitInLoops: one database at a time, deliberately
    const last = await ctx.db.query.backups.findFirst({
      orderBy: desc(backups.createdAt),
      where: and(
        eq(backups.databaseId, database.id),
        eq(backups.status, "completed")
      ),
    });

    // A backup already in flight must not trigger a second one: two
    // simultaneous dumps of the same database would fight over the
    // server's disk.
    const inFlight = await ctx.db.query.backups.findFirst({
      where: and(
        eq(backups.databaseId, database.id),
        eq(backups.status, "running")
      ),
    });
    if (inFlight) {
      continue;
    }

    const due = !last || Date.now() - last.createdAt.getTime() >= interval;
    if (!due) {
      continue;
    }

    // THIS database's destination — its prefix goes into the object key.
    // A misconfigured database (no destination, or several with none
    // chosen) is SKIPPED, not propagated: a sweep that throws would also
    // stop scheduling for every other database, even correctly configured
    // ones. Same rule as for an unreachable server during metrics
    // collection.
    //
    // `resolveDestinationRow`, not `resolveDestination`: at this stage
    // we're only picking a prefix, not a single byte moves yet —
    // decrypting the secret here would be wasted work.
    let resolved: Awaited<ReturnType<typeof resolveDestinationRow>>;
    try {
      resolved = await resolveDestinationRow(ctx.db, database.s3DestinationId);
    } catch {
      continue;
    }

    const [created] = await ctx.db
      .insert(backups)
      .values(buildBackupInsert({ database, kind: "scheduled", resolved }))
      .returning();
    if (created) {
      await enqueue(created.id);
      result.queued.push(created.id);
    }
  }

  return result;
}

/**
 * Prunes successful backups beyond the database's retention.
 *
 * Called AFTER a successful backup, never before: pruning first would
 * shrink the window during which there's still something to restore if the
 * following dump fails.
 *
 * The object is removed from the bucket AND the database row. An object
 * whose deletion fails leaves its row in place rather than creating a row
 * that claims to exist without an object — that's the protective reading
 * direction: better an orphaned object than a phantom backup offered up
 * for restore.
 */
export async function pruneBackups(
  ctx: DeployContext,
  databaseId: string
): Promise<string[]> {
  const database = await ctx.db.query.databases.findFirst({
    where: eq(databases.id, databaseId),
  });
  if (!database) {
    return [];
  }

  const kept = await ctx.db.query.backups.findMany({
    orderBy: desc(backups.createdAt),
    where: and(
      eq(backups.databaseId, databaseId),
      eq(backups.status, "completed")
    ),
  });
  const excess = kept.slice(database.backupRetention);
  if (excess.length === 0) {
    return [];
  }

  // ONE destination per backup, not one for the whole prune run: two
  // backups of the same database can live in two different buckets if the
  // destination changed in between. Deleting the key in the wrong bucket
  // wouldn't throw — the intended object would stay, and so would the one
  // we thought we'd purged. Cached by id: the current prune run almost
  // always lands on the same one.
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
      // The object may have been purged by hand. We continue: the row must
      // go either way, otherwise it would reappear as restorable while its
      // object no longer exists.
    }
    await ctx.db.delete(backups).where(eq(backups.id, backup.id));
    removed.push(backup.objectKey);
  }

  return removed;
}
