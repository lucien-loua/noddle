import {
  buildVolumeBackupInsert,
  resolveDestination,
  resolveDestinationRow,
} from "@noddle/backup";
import { deleteObject } from "@noddle/backup-store";
import { volumeBackupConfigs, volumeBackups } from "@noddle/db/schema";
import { Cron } from "croner";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { DeployContext } from "#runtime-context";

export interface VolumeBackupSweepResult {
  pruned: string[];
  queued: string[];
}

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

export async function sweepVolumeBackups(
  ctx: DeployContext,
  enqueue: (volumeBackupId: string) => Promise<unknown>
): Promise<VolumeBackupSweepResult> {
  const result: VolumeBackupSweepResult = { pruned: [], queued: [] };
  const now = new Date();

  const configs = await ctx.db.query.volumeBackupConfigs.findMany({
    where: eq(volumeBackupConfigs.enabled, true),
    with: { service: true },
  });

  for (const config of configs) {
    if (config.service.status !== "running") {
      continue;
    }

    const inFlight = await ctx.db.query.volumeBackups.findFirst({
      where: and(
        eq(volumeBackups.configId, config.id),
        inArray(volumeBackups.status, ["queued", "running"])
      ),
    });
    if (inFlight) {
      continue;
    }

    const last = await ctx.db.query.volumeBackups.findFirst({
      orderBy: desc(volumeBackups.createdAt),
      where: and(
        eq(volumeBackups.configId, config.id),
        eq(volumeBackups.status, "completed")
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
      .insert(volumeBackups)
      .values(
        buildVolumeBackupInsert({
          configId: config.id,
          configPrefix: config.prefix,
          kind: "scheduled",
          resolved,
          service: config.service,
          volumeName: config.volumeName,
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

export async function pruneVolumeBackups(
  ctx: DeployContext,
  opts: { configId: string | null; serviceId: string }
): Promise<string[]> {
  if (!opts.configId) {
    return [];
  }

  const config = await ctx.db.query.volumeBackupConfigs.findFirst({
    where: eq(volumeBackupConfigs.id, opts.configId),
  });
  if (!config?.keepLatestCount) {
    return [];
  }

  const kept = await ctx.db.query.volumeBackups.findMany({
    orderBy: desc(volumeBackups.createdAt),
    where: and(
      eq(volumeBackups.configId, opts.configId),
      eq(volumeBackups.status, "completed")
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
    await ctx.db.delete(volumeBackups).where(eq(volumeBackups.id, backup.id));
    removed.push(backup.objectKey);
  }

  return removed;
}
