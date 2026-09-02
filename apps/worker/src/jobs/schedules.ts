import type { DeployJobData } from "@noddle/deploy-contract";
import { defineSchedule } from "@noddle/deploy-contract/schedule";
import type { ScheduleSpec } from "@noddle/deploy-contract/schedule";
import { reconcileRepositoryHooks } from "@noddle/git-provider-credentials/hooks";

import { sweepBackups } from "#backup-sweep";
import { collectMetrics } from "#metrics";
import { sweepRegistryTrust } from "#registry";
import type { DeployContext, RouteOptions } from "#runtime-context";
import { sweepWatch } from "#sweep";
import { sweepVolumeBackups } from "#volume-backup-sweep";

export interface SweepDeps {
  ctx: DeployContext;
  enqueue: (job: DeployJobData) => Promise<unknown>;
  route: RouteOptions;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const schedules: ScheduleSpec<SweepDeps>[] = [
  defineSchedule<SweepDeps>({
    every: 30_000,
    id: "sweep",
    queue: "noddle-watch",
    run: ({ ctx, route }) => sweepWatch(ctx, route),
  }),

  defineSchedule<SweepDeps>({
    every: 5 * MINUTE,
    id: "backup-sweep",
    queue: "noddle-backup-sweep",
    run: async ({ ctx, enqueue }) => {
      await sweepBackups(ctx, (backupId) =>
        enqueue({ backupId, kind: "backup" })
      );
      await sweepVolumeBackups(ctx, (volumeBackupId) =>
        enqueue({ kind: "volume-backup", volumeBackupId })
      );
    },
  }),

  defineSchedule<SweepDeps>({
    every: 5 * MINUTE,
    id: "registry-trust",
    queue: "noddle-registry-trust",
    run: ({ ctx }) =>
      sweepRegistryTrust({
        connectTo: ctx.connectTo,
        createDockerApi: ctx.createDockerApi,
        db: ctx.db,
        registry: ctx.registry,
      }),
  }),

  defineSchedule<SweepDeps>({
    every: HOUR,
    id: "registry-prune",
    queue: "noddle-registry-prune",
    run: ({ enqueue }) => enqueue({ kind: "prune-registry" }),
  }),

  defineSchedule<SweepDeps>({
    every: DAY,
    id: "docker-prune",
    queue: "noddle-docker-prune",
    run: ({ enqueue }) => enqueue({ kind: "prune-docker" }),
  }),

  defineSchedule<SweepDeps>({
    every: 10 * MINUTE,
    id: "repository-hooks",
    queue: "noddle-repository-hooks",
    run: ({ ctx }) => reconcileRepositoryHooks(ctx.db, ctx.appKey),
  }),

  defineSchedule<SweepDeps>({
    every: MINUTE,
    id: "collect",
    queue: "noddle-metrics",
    run: ({ ctx }) => collectMetrics(ctx),
  }),
];
