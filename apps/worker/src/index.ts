import { loadAppKey } from "@noddle/crypto";
import { createDatabase } from "@noddle/db";
import { deployments, stackDeployments } from "@noddle/db/schema";
import { DEPLOY_QUEUE_CONCURRENCY, DEPLOY_QUEUE_NAME, deployJobSchema } from '@noddle/deploy-contract';
import type { DeployJobData } from '@noddle/deploy-contract';
import { createDeployQueue } from "@noddle/deploy-contract/queue";
import { startSchedule } from "@noddle/deploy-contract/schedule";
import { UnrecoverableError, Worker } from "bullmq";
import { eq } from "drizzle-orm";
import IORedis from "ioredis";

import { recoverStaleDatabaseBackups } from "#backup-run/subjects/database";
import { recoverStaleVolumeBackups } from "#backup-run/subjects/volume";
import { dispatch, handlers } from "#handlers";
import { createLogBus } from "#log-bus";
import { loadRegistryConfig } from "#registry";
import type { BuildOptions, RouteOptions, WorkerDeps } from "#runtime-context";
import { createDeployContext } from "#runtime-context";
import { schedules } from "#schedules";

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

const ctx = createDeployContext({
  appKey: loadAppKey(process.env.APP_KEY),
  db: createDatabase({ url: required("DATABASE_URL") }),
  // Absent on an installation whose stack doesn't have the registry yet: the
  // worker then falls back exactly to the previous behavior, local build and
  // pinned service. This is what makes an update safe.
  registry: loadRegistryConfig(),
});

const route: RouteOptions = {
  // Set by the installer ONLY when a domain is configured: without a name,
  // no certificate is possible and applications go out over HTTP.
  certResolver: process.env.CERT_RESOLVER || undefined,
  networkName: process.env.TRAEFIK_NETWORK ?? "noddle-public",
};

const build: BuildOptions = {
  logRoot: process.env.LOG_ROOT ?? "/var/lib/noddle/logs",
  onLog: (deploymentId: string, chunk: string) =>
    logBus.publish(deploymentId, { data: chunk, type: "chunk" }),
};

const deps: WorkerDeps = { build, ctx, route };

const { enqueue: enqueueDeploy, queue: deployQueue } =
  createDeployQueue(connection);

const recoveredVolume = await recoverStaleVolumeBackups(ctx);
const recoveredDatabase = await recoverStaleDatabaseBackups(ctx);
const recovered = recoveredVolume + recoveredDatabase;
if (recovered > 0) {
  process.stderr.write(
    `recovered ${recovered} stale backup(s) stuck in running (${recoveredDatabase} database, ${recoveredVolume} volume)\n`
  );
}

export { deployQueue };

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
      await dispatch(handlers, deps, data);
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
// Recurring sweeps
// ─────────────────────────────────────────────────────────────────────────────
//
// Watch, scheduled backups, registry trust, registry retention, Docker prune
// and metrics. Each one's cadence and its reason live with its entry in
// `schedules.ts`; concurrency 1 is enforced by `startSchedule` and is not a
// per-sweep knob.

const running = await Promise.all(
  schedules.map((spec) =>
    startSchedule(spec, {
      connection,
      deps: { ctx, enqueue: enqueueDeploy, route },
      onFailed: (queue, message) =>
        process.stderr.write(`${queue}: ${message}\n`),
    })
  )
);

// ─────────────────────────────────────────────────────────────────────────────

deployWorker.on("failed", (job, err) => {
  process.stderr.write(`job ${job?.id} failed: ${err.message}\n`);
});

async function shutdown(): Promise<void> {
  // Clean shutdown: a deployment in progress runs to completion rather than
  // being cut off in the middle of a Swarm rollout.
  await Promise.all([
    deployWorker.close(),
    ...running.map((schedule) => schedule.close()),
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
