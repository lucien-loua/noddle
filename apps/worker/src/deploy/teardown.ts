import { unlink } from "node:fs/promises";

import { deployments, services } from "@noddle/db/schema";
import {
  deleteManifest,
  garbageCollect,
  parseRegistryRef,
  removeService,
} from "@noddle/deploy-engine/ops";
import { markFailed } from "@noddle/shared/lifecycle";
import { swarmServiceName } from "@noddle/shared/swarm-names";
import { execArgv } from "@noddle/ssh-executor";
import type { dockerClient } from "@noddle/ssh-executor";
import { eq } from "drizzle-orm";

import { withDeployClients } from "#job-run";
import type { DeployClients } from "#job-run";
import { BUILD_ROOT } from "#runtime-context";
import type { DeployContext } from "#runtime-context";

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

async function teardownService(
  ctx: DeployContext,
  service: ServiceRow,
  rows: DeploymentRow[],
  opts: { containerName?: string },
  clients: DeployClients
): Promise<void> {
  const { buildClient, managerClient, managerDocker } = clients;

  await removeService(managerDocker, swarmServiceName(service));

  await ctx.db.delete(services).where(eq(services.id, service.id));

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
    return;
  }

  const rows = await loadDeploymentsForTeardown(ctx, serviceId);

  try {
    await withDeployClients(ctx, service.server, (clients) =>
      teardownService(ctx, service, rows, opts, clients)
    );
  } catch (error) {
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
  await execArgv(o.buildClient, [
    "sudo",
    "rm",
    "-rf",
    `${BUILD_ROOT}/${o.serviceId}`,
  ]).catch(() => {});

  for (const tag of o.imageTags) {
    await execArgv(o.buildClient, ["sudo", "docker", "rmi", "-f", tag]).catch(
      () => {}
    );
  }

  if (ctx.registry) {
    let deletedAny = false;
    for (const tag of o.imageTags) {
      const ref = parseRegistryRef(tag, ctx.registry);
      if (!ref) {
        continue;
      }
      const gone = await deleteManifest(ctx.registry, ref).catch(() => false);
      deletedAny ||= gone;
    }
    if (deletedAny) {
      await garbageCollect(o.managerClient, o.registryContainer).catch(
        () => {}
      );
    }
  }

  for (const path of o.logPaths) {
    await unlink(path).catch(() => {});
  }
}
