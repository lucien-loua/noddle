import { createDatabase } from "@noddle/db";
import { deployments, stackDeployments } from "@noddle/db/schema";
import {
  DEPLOY_QUEUE_CONCURRENCY,
  DEPLOY_QUEUE_NAME,
  type DeployJobData,
  deployJobSchema,
} from "@noddle/deploy-contract";
import { loadAppKey } from "@noddle/shared/crypto";
import { Queue, UnrecoverableError, Worker } from "bullmq";
import { eq } from "drizzle-orm";
import IORedis from "ioredis";
import { sweepBackups } from "#backup-sweep";
import { connectTo, type DeployContext, runJob } from "#deploy";
import { createLogBus } from "#log-bus";
import { collectMetrics } from "#metrics";
import { loadRegistryConfig, sweepRegistryTrust } from "#registry";
import { sweepWatch } from "#sweep";

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`required environment variable: ${name}`);
  }
  return v;
}

const connection = new IORedis(required("REDIS_URL"), {
  // Required by BullMQ: without this, a long job can be considered lost.
  maxRetriesPerRequest: null,
});

// The bridge to the dashboard. The log sink writes to disk for history; this
// publishes the same source to the web app, which lives in a different
// process and on a different runtime.
const logBus = createLogBus(connection);

const ctx: DeployContext = {
  appKey: loadAppKey(process.env.APP_KEY),
  // Set by the installer ONLY when a domain is configured: without a name,
  // no certificate is possible and applications go out over HTTP.
  certResolver: process.env.CERT_RESOLVER || undefined,
  db: createDatabase({ url: required("DATABASE_URL") }),
  logRoot: process.env.LOG_ROOT ?? "/var/lib/noddle/logs",
  networkName: process.env.TRAEFIK_NETWORK ?? "noddle-public",
  onLog: (deploymentId, chunk) =>
    logBus.publish(deploymentId, { data: chunk, type: "chunk" }),
  // Absent on an installation whose stack doesn't have the registry yet: the
  // worker then falls back exactly to the previous behavior, local build and
  // pinned service. This is what makes an update safe.
  registry: loadRegistryConfig(),
};

export const deployQueue = new Queue<DeployJobData>(DEPLOY_QUEUE_NAME, {
  connection,
});

/** Mirror of the web helper: parse then add. No raw `.add` on this queue. */
function enqueueDeploy(job: DeployJobData): Promise<unknown> {
  const parsed = deployJobSchema.parse(job);
  return deployQueue.add(parsed.kind, parsed);
}

function parseDeployJob(data: unknown): DeployJobData {
  const result = deployJobSchema.safeParse(data);
  if (!result.success) {
    throw new UnrecoverableError(`invalid deploy job: ${result.error.message}`);
  }
  return result.data;
}

// ─────────────────────────────────────────────────────────────────────────────
// Deployments
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Closes watchers' SSE stream.
 *
 * The status is READ BACK from the database rather than inferred from
 * whether the job threw or not: `docker service update` returns 0 even after
 * a rollback, and that's precisely the mistake the "never infer success from
 * an exit code" rule forbids. The database carries the real state, read from
 * the Docker API.
 */
async function announceEnd(deploymentId: string): Promise<void> {
  const row = await ctx.db.query.deployments.findFirst({
    where: eq(deployments.id, deploymentId),
  });
  logBus.publish(deploymentId, {
    status: row?.status ?? "failed",
    type: "end",
  });
}

/** Same role as `announceEnd`, for a stack deployment. */
async function announceStackEnd(stackDeploymentId: string): Promise<void> {
  const row = await ctx.db.query.stackDeployments.findFirst({
    where: eq(stackDeployments.id, stackDeploymentId),
  });
  logBus.publish(stackDeploymentId, {
    status: row?.status ?? "failed",
    type: "end",
  });
}

const deployWorker = new Worker<DeployJobData>(
  DEPLOY_QUEUE_NAME,
  async (job) => {
    const data = parseDeployJob(job.data);
    try {
      await runJob(ctx, data);
    } finally {
      // Even on failure: an open tab must see the stream close, not sit
      // waiting forever. A server provisioning has no associated
      // deployment: nothing to close on the SSE side.
      if (data.kind === "deploy") {
        await announceEnd(data.deploymentId);
      } else if (data.kind === "deploy-stack") {
        await announceStackEnd(data.stackDeploymentId);
      }
    }
  },
  {
    // Only one deployment at a time per worker. Two simultaneous builds on a
    // 2GB VM would fight over the memory the cap is meant to protect.
    concurrency: DEPLOY_QUEUE_CONCURRENCY,
    connection,
    // A deployment lasts minutes: without this, BullMQ thinks it's dead and
    // relaunches it in parallel with itself.
    lockDuration: 30 * 60 * 1000,
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Post-deployment watch
// ─────────────────────────────────────────────────────────────────────────────
//
// Swarm's guarantee expires with its monitor window: a service that converges
// then dies a minute later is declared "completed" and loops on the broken
// image, with nothing left for Swarm to restore. Measured in Phase 0: 9
// requests out of 12 failing, indefinitely. The logic lives in sweep.ts so it
// can be tested without starting this process.

const WATCH_QUEUE = "noddle-watch";

const watchQueue = new Queue(WATCH_QUEUE, { connection });
const watchWorker = new Worker(WATCH_QUEUE, () => sweepWatch(ctx), {
  concurrency: 1,
  connection,
});

await watchQueue.upsertJobScheduler(
  "sweep",
  { every: 30_000 },
  { name: "sweep" }
);

// ─────────────────────────────────────────────────────────────────────────────
// Scheduled backups
// ─────────────────────────────────────────────────────────────────────────────
//
// A sweep that queries Postgres, not a per-database BullMQ scheduler: the
// state lives in the database, so a flushed Redis — which happens, it's a
// cache — doesn't silently make schedules disappear. Five minutes is enough
// for a daily or weekly cadence.

const BACKUP_SWEEP_QUEUE = "noddle-backup-sweep";

const backupSweepQueue = new Queue(BACKUP_SWEEP_QUEUE, { connection });
const backupSweepWorker = new Worker(
  BACKUP_SWEEP_QUEUE,
  () =>
    sweepBackups(ctx, (backupId) =>
      enqueueDeploy({ backupId, kind: "backup" })
    ),
  { concurrency: 1, connection }
);

await backupSweepQueue.upsertJobScheduler(
  "backup-sweep",
  { every: 300_000 },
  { name: "backup-sweep" }
);

// ─────────────────────────────────────────────────────────────────────────────
// Registry trust
// ─────────────────────────────────────────────────────────────────────────────
//
// Every node must carry the registry's CA, otherwise its daemon refuses to
// pull. Servers that are added go through `provisionServer`, which deposits
// it; this sweep exists for the TWO cases provisioning doesn't cover: servers
// already in place before the registry existed, and ones that were
// unreachable at the time we tried.
//
// Five minutes: it only writes a 2KB file once, and does nothing further
// after that.

const TRUST_QUEUE = "noddle-registry-trust";

const trustQueue = new Queue(TRUST_QUEUE, { connection });
const trustWorker = new Worker(
  TRUST_QUEUE,
  () =>
    sweepRegistryTrust({
      connectTo: (server) => connectTo(ctx, server),
      db: ctx.db,
      registry: ctx.registry,
    }),
  { concurrency: 1, connection }
);

await trustQueue.upsertJobScheduler(
  "registry-trust",
  { every: 300_000 },
  { name: "registry-trust" }
);

// ─────────────────────────────────────────────────────────────────────────────
// Registry retention
// ─────────────────────────────────────────────────────────────────────────────
//
// This sweep executes NOTHING itself: it drops a job on the deployments
// queue. That's the point that matters — `garbage-collect` deletes layers no
// manifest references, and a layer currently being pushed is exactly that
// case. Only that queue's concurrency 1 guarantees a GC never runs during a
// push. Same reason as backups, which share the queue so as not to compete
// for a 2GB machine's memory.
//
// One hour: the registry grows one deployment at a time, there's nothing to
// catch up on any faster than that.

const PRUNE_QUEUE = "noddle-registry-prune";

const pruneQueue = new Queue(PRUNE_QUEUE, { connection });
const pruneWorker = new Worker(
  PRUNE_QUEUE,
  () => enqueueDeploy({ kind: "prune-registry" }),
  { concurrency: 1, connection }
);

await pruneQueue.upsertJobScheduler(
  "registry-prune",
  { every: 3_600_000 },
  { name: "registry-prune" }
);

// ─────────────────────────────────────────────────────────────────────────────
// Docker prune
// ─────────────────────────────────────────────────────────────────────────────
//
// Same shape as the registry retention sweep just above: this sweep prunes
// NOTHING itself, it drops a job on the deployments queue. The pattern is
// identical and the reason even more direct — between `buildx --load` and
// `pushImage`, the freshly built image isn't referenced by any container, so
// a concurrent prune would delete it.
//
// Daily, not hourly like the registry: the prune destroys images the
// registry doesn't have (ones from before it), and a node's disk doesn't
// fill up in an hour. A rare cadence also keeps the reconciliation readable
// in the audit log… which it doesn't write to, but in the deployment
// history where "expired" suddenly shows up.

const DOCKER_PRUNE_QUEUE = "noddle-docker-prune";

const dockerPruneQueue = new Queue(DOCKER_PRUNE_QUEUE, { connection });
const dockerPruneWorker = new Worker(
  DOCKER_PRUNE_QUEUE,
  () => enqueueDeploy({ kind: "prune-docker" }),
  { concurrency: 1, connection }
);

await dockerPruneQueue.upsertJobScheduler(
  "docker-prune",
  { every: 86_400_000 },
  { name: "docker-prune" }
);

// ─────────────────────────────────────────────────────────────────────────────
// Resource collection
// ─────────────────────────────────────────────────────────────────────────────
//
// One minute: fine-grained enough to see a memory leak climbing, coarse
// enough that a 2GB machine doesn't spend all its time measuring itself.

const METRICS_QUEUE = "noddle-metrics";

const metricsQueue = new Queue(METRICS_QUEUE, { connection });
const metricsWorker = new Worker(METRICS_QUEUE, () => collectMetrics(ctx), {
  // Concurrency 1: two overlapping runs would open two SSH connections per
  // machine and skew the CPU deltas.
  concurrency: 1,
  connection,
});

await metricsQueue.upsertJobScheduler(
  "collect",
  { every: 60_000 },
  { name: "collect" }
);

// ─────────────────────────────────────────────────────────────────────────────

for (const w of [
  deployWorker,
  watchWorker,
  backupSweepWorker,
  metricsWorker,
  trustWorker,
  pruneWorker,
  dockerPruneWorker,
]) {
  w.on("failed", (job, err) => {
    process.stderr.write(`job ${job?.id} failed: ${err.message}\n`);
  });
}

async function shutdown(): Promise<void> {
  // Clean shutdown: a deployment in progress runs to completion rather than
  // being cut off in the middle of a Swarm rollout.
  await Promise.all([
    deployWorker.close(),
    watchWorker.close(),
    backupSweepWorker.close(),
    metricsWorker.close(),
    trustWorker.close(),
    pruneWorker.close(),
    dockerPruneWorker.close(),
  ]);
  await logBus.close();
  await connection.quit();
}

process.on("SIGTERM", () => {
  shutdown().finally(() => process.exit(0));
});
process.on("SIGINT", () => {
  shutdown().finally(() => process.exit(0));
});

process.stdout.write("noddle worker started\n");
