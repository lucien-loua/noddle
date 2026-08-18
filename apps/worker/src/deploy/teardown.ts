import { unlink } from "node:fs/promises";

import { deployments, services } from "@noddle/db/schema";
import {
  deleteManifest,
  garbageCollect,
  parseRegistryRef,
} from "@noddle/registry";
import { markFailed } from "@noddle/shared/lifecycle";
import { swarmServiceName } from "@noddle/shared/swarm-names";
import { execArgv } from "@noddle/ssh-executor";
import type { dockerClient } from "@noddle/ssh-executor";
import { removeService } from "@noddle/swarm-ops";
import { eq } from "drizzle-orm";

import { withDeployClients } from "#job-run";
import type { DeployClients } from "#job-run";
import { BUILD_ROOT } from "#runtime-context";
import type { DeployContext } from "#runtime-context";

/** The registry container in the control-plane Compose stack. */
const REGISTRY_CONTAINER = "noddle-registry-1";

const FILE_URL = "file://";

type ServiceRow = NonNullable<
  Awaited<ReturnType<typeof loadServiceForTeardown>>
>;
type DeploymentRow = Awaited<
  ReturnType<typeof loadDeploymentsForTeardown>
>[number];

function loadServiceForTeardown(ctx: DeployContext, serviceId: string) {
  return ctx.db.query.services.findFirst({
    where: eq(services.id, serviceId),
    with: { server: true },
  });
}

function loadDeploymentsForTeardown(ctx: DeployContext, serviceId: string) {
  return ctx.db.query.deployments.findMany({
    where: eq(deployments.serviceId, serviceId),
    with: { logs: true },
  });
}

/**
 * The three steps that need the SSH connection: remove the Swarm service,
 * drop the row, then best-effort disk cleanup. Hoisted out of
 * `runServiceTeardown` so the guard's closure does not push an already
 * dense function past the complexity ceiling.
 */
async function teardownService(
  ctx: DeployContext,
  service: ServiceRow,
  rows: DeploymentRow[],
  opts: { containerName?: string },
  clients: DeployClients
): Promise<void> {
  const { buildClient, managerClient, managerDocker } = clients;

  // ── 1. Swarm — must succeed ────────────────────────────────────────────
  await removeService(managerDocker, swarmServiceName(service));

  // ── 2. the database — the screen can now tell the truth ───────────────
  // `deployments`, `deployment_logs`, `env_vars` and `service_metrics` go
  // in cascade (see the schema).
  await ctx.db.delete(services).where(eq(services.id, service.id));

  // ── 3. the bytes — best-effort, never blocking ─────────────────────────
  await purgeBytes(ctx, {
    buildClient,
    imageTags: rows.map((r) => r.imageTag).filter((t): t is string => !!t),
    logPaths: rows.flatMap((r) =>
      r.logs
        .map((l) => l.storageUrl)
        .filter((u) => u.startsWith(FILE_URL))
        .map((u) => u.slice(FILE_URL.length))
    ),
    managerClient,
    registryContainer: opts.containerName ?? REGISTRY_CONTAINER,
    serviceId: service.id,
  });
}

export async function runServiceTeardown(
  ctx: DeployContext,
  serviceId: string,
  opts: { containerName?: string } = {}
): Promise<void> {
  const service = await loadServiceForTeardown(ctx, serviceId);
  if (!service) {
    // Already deleted — the job may have been replayed. Nothing to do, and
    // especially not an error: the desired result is reached.
    return;
  }

  const rows = await loadDeploymentsForTeardown(ctx, serviceId);

  try {
    // The connection is opened by `withDeployClients` itself, inside this
    // `try`: a failed key decrypt is the most common failure in practice,
    // and must also write to `last_error` — otherwise a row stuck in
    // `deleting` still says nothing about WHY. `withDeployClients` throwing
    // before its own connection is made costs nothing to disconnect, so the
    // catch below covers that case the same way it covers every other.
    await withDeployClients(ctx, service.server, (clients) =>
      teardownService(ctx, service, rows, opts, clients)
    );
  } catch (error) {
    // If step 2 already succeeded, the row no longer exists: the update
    // then touches nothing, which is the desired result — not a second
    // error to handle.
    await ctx.db
      .update(services)
      .set(
        markFailed(
          "deleting",
          error instanceof Error ? error.message : String(error)
        )
      )
      .where(eq(services.id, serviceId));
    throw error;
  }
}

/**
 * Everything that is only disk space. Each step is isolated: one that
 * fails must not block the following ones, and none must fail the
 * deletion — the service is already stopped and the row already gone.
 */
async function purgeBytes(
  ctx: DeployContext,
  o: {
    buildClient: Parameters<typeof dockerClient>[0];
    imageTags: string[];
    logPaths: string[];
    managerClient: Parameters<typeof dockerClient>[0];
    registryContainer: string;
    serviceId: string;
  }
): Promise<void> {
  // The clone directory on the build server.
  await execArgv(o.buildClient, [
    "sudo",
    "rm",
    "-rf",
    `${BUILD_ROOT}/${o.serviceId}`,
  ]).catch(() => {
    /* empty */
  });

  // Local images, if any remain (a pre-registry version, or an image
  // re-pulled by the node that was running the service).
  for (const tag of o.imageTags) {
    // biome-ignore lint/performance/noAwaitInLoops: one image at a time, deliberately
    await execArgv(o.buildClient, ["sudo", "docker", "rmi", "-f", tag]).catch(
      () => {
        /* empty */
      }
    );
  }

  // The registry repository: each tag, then garbage collection — otherwise
  // the layers would remain, measured.
  if (ctx.registry) {
    let deletedAny = false;
    for (const tag of o.imageTags) {
      const ref = parseRegistryRef(tag, ctx.registry);
      if (!ref) {
        continue;
      }
      // biome-ignore lint/performance/noAwaitInLoops: one manifest at a time, deliberately
      const gone = await deleteManifest(ctx.registry, ref).catch(() => false);
      deletedAny ||= gone;
    }
    if (deletedAny) {
      await garbageCollect(o.managerClient, o.registryContainer).catch(() => {
        /* empty */
      });
    }
  }

  // Log files, on the control plane — not on the target.
  for (const path of o.logPaths) {
    // biome-ignore lint/performance/noAwaitInLoops: one file at a time, deliberately
    await unlink(path).catch(() => {
      /* empty */
    });
  }
}
