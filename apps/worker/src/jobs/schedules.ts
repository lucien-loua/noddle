/**
 * Every recurring sweep the worker runs.
 *
 * One entry per sweep, so `index.ts` can go back to being a process host.
 * The reasons for each cadence are kept with their entry — they are the
 * record of why 30 s and not 5, why daily and not hourly.
 */
import type { DeployJobData } from "@noddle/deploy-contract";
import {
  defineSchedule,
  type ScheduleSpec,
} from "@noddle/deploy-contract/schedule";
import { sweepBackups } from "#backup-sweep";
import { collectMetrics } from "#metrics";
import { sweepRegistryTrust } from "#registry";
import {
  connectTo,
  type DeployContext,
  type RouteOptions,
} from "#runtime-context";
import { sweepWatch } from "#sweep";
import { sweepVolumeBackups } from "#volume-backup-sweep";

export interface SweepDeps {
  ctx: DeployContext;
  enqueue: (job: DeployJobData) => Promise<unknown>;
  /** Only `sweep`'s watch needs it — the post-deploy watch redeploys a
   *  previous image on its own (ADR-0012), which is a route, not a build. */
  route: RouteOptions;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * The `id` of each entry is the scheduler id ALREADY registered in Redis on
 * installations in the field. Do not tidy them into the queue name: the old
 * entry would survive the upgrade and the sweep would fire twice.
 */
export const schedules: ScheduleSpec<SweepDeps>[] = [
  // Swarm's guarantee expires with its monitor window: a service that
  // converges then dies a minute later is declared "completed" and loops on
  // the broken image, with nothing left for Swarm to restore. Measured in
  // Phase 0: 9 requests out of 12 failing, indefinitely. The logic lives in
  // sweep.ts so it can be tested without starting this process.
  defineSchedule<SweepDeps>({
    every: 30_000,
    id: "sweep",
    queue: "noddle-watch",
    run: ({ ctx, route }) => sweepWatch(ctx, route),
  }),

  // A sweep that queries Postgres, not a per-database BullMQ scheduler: the
  // state lives in the database, so a flushed Redis — which happens, it's a
  // cache — doesn't silently make schedules disappear. Five minutes is
  // enough for a daily or weekly cadence.
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

  // Every node must carry the registry's CA, otherwise its daemon refuses to
  // pull. Servers that are added go through `provisionServer`, which
  // deposits it; this sweep exists for the TWO cases provisioning doesn't
  // cover: servers already in place before the registry existed, and ones
  // that were unreachable at the time we tried.
  //
  // Five minutes: it only writes a 2KB file once, and does nothing further
  // after that.
  defineSchedule<SweepDeps>({
    every: 5 * MINUTE,
    id: "registry-trust",
    queue: "noddle-registry-trust",
    run: ({ ctx }) =>
      sweepRegistryTrust({
        connectTo: (server) => connectTo(ctx, server),
        db: ctx.db,
        registry: ctx.registry,
      }),
  }),

  // This sweep executes NOTHING itself: it drops a job on the deployments
  // queue. That's the point that matters — `garbage-collect` deletes layers
  // no manifest references, and a layer currently being pushed is exactly
  // that case. Only that queue's concurrency 1 guarantees a GC never runs
  // during a push. Same reason as backups, which share the queue so as not
  // to compete for a 2GB machine's memory.
  //
  // One hour: the registry grows one deployment at a time, there's nothing
  // to catch up on any faster than that.
  defineSchedule<SweepDeps>({
    every: HOUR,
    id: "registry-prune",
    queue: "noddle-registry-prune",
    run: ({ enqueue }) => enqueue({ kind: "prune-registry" }),
  }),

  // Same shape as the registry retention sweep just above: this sweep prunes
  // NOTHING itself, it drops a job on the deployments queue. The pattern is
  // identical and the reason even more direct — between `buildx --load` and
  // `pushImage`, the freshly built image isn't referenced by any container,
  // so a concurrent prune would delete it.
  //
  // Daily, not hourly like the registry: the prune destroys images the
  // registry doesn't have (ones from before it), and a node's disk doesn't
  // fill up in an hour. A rare cadence also keeps the reconciliation
  // readable in the deployment history, where "expired" suddenly shows up.
  defineSchedule<SweepDeps>({
    every: DAY,
    id: "docker-prune",
    queue: "noddle-docker-prune",
    run: ({ enqueue }) => enqueue({ kind: "prune-docker" }),
  }),

  // One minute: fine-grained enough to see a memory leak climbing, coarse
  // enough that a 2GB machine doesn't spend all its time measuring itself.
  defineSchedule<SweepDeps>({
    every: MINUTE,
    id: "collect",
    queue: "noddle-metrics",
    run: ({ ctx }) => collectMetrics(ctx),
  }),
];
