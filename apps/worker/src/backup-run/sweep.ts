import {
  resolveDestination,
  resolveDestinationRow,
  deleteObject,
} from "@noddle/backup";
import { isConfigDue } from "@noddle/backup/schedule";

import type { DeployContext } from "#runtime-context";

export interface BackupSweepResult {
  pruned: string[];
  queued: string[];
}

export interface BackupSweepSubject<TConfig> {
  configDestinationId: (config: TConfig) => string;
  configId: (config: TConfig) => string;
  configSchedule: (config: TConfig) => string;
  findInFlight: (ctx: DeployContext, configId: string) => Promise<boolean>;
  findLastCompletedAt: (
    ctx: DeployContext,
    configId: string
  ) => Promise<Date | null>;
  insertScheduled: (
    ctx: DeployContext,
    config: TConfig,
    resolved: Awaited<ReturnType<typeof resolveDestinationRow>>
  ) => Promise<{ id: string } | null>;
  isParentActive: (config: TConfig) => boolean;
  loadEnabledConfigs: (ctx: DeployContext) => Promise<TConfig[]>;
}

export async function sweepBackupConfigs<TConfig>(
  subject: BackupSweepSubject<TConfig>,
  ctx: DeployContext,
  enqueue: (runId: string) => Promise<unknown>
): Promise<BackupSweepResult> {
  const result: BackupSweepResult = { pruned: [], queued: [] };
  const now = new Date();
  const configs = await subject.loadEnabledConfigs(ctx);

  for (const config of configs) {
    if (!subject.isParentActive(config)) {
      continue;
    }

    const configId = subject.configId(config);

    if (await subject.findInFlight(ctx, configId)) {
      continue;
    }

    const lastCompletedAt = await subject.findLastCompletedAt(ctx, configId);
    if (!isConfigDue(subject.configSchedule(config), lastCompletedAt, now)) {
      continue;
    }

    let resolved: Awaited<ReturnType<typeof resolveDestinationRow>>;
    try {
      resolved = await resolveDestinationRow(
        ctx.db,
        subject.configDestinationId(config)
      );
    } catch {
      continue;
    }

    const created = await subject.insertScheduled(ctx, config, resolved);
    if (created) {
      await enqueue(created.id);
      result.queued.push(created.id);
    }
  }

  return result;
}

export interface BackupPruneSubject {
  deleteRun: (ctx: DeployContext, runId: string) => Promise<void>;
  findExcessRuns: (
    ctx: DeployContext,
    configId: string,
    keepLatestCount: number
  ) => Promise<
    { destinationId: string | null; id: string; objectKey: string }[]
  >;
  loadKeepLatestCount: (
    ctx: DeployContext,
    configId: string
  ) => Promise<number | null | undefined>;
}

export async function pruneBackupRuns(
  subject: BackupPruneSubject,
  ctx: DeployContext,
  opts: { configId: string | null }
): Promise<string[]> {
  if (!opts.configId) {
    return [];
  }

  const keepLatestCount = await subject.loadKeepLatestCount(ctx, opts.configId);
  if (!keepLatestCount) {
    return [];
  }

  const excess = await subject.findExcessRuns(
    ctx,
    opts.configId,
    keepLatestCount
  );
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
    } catch {}
    await subject.deleteRun(ctx, backup.id);
    removed.push(backup.objectKey);
  }

  return removed;
}
