import {
  buildImage,
  buildImageFromDockerfile,
  computeBuildCap,
  ensureCappedBuilder,
  fetchSource,
} from "@noddle/build-engine";
import type { Database } from "@noddle/db";
import {
  deploymentLogs,
  deployments,
  servers,
  services,
} from "@noddle/db/schema";
import { rolloutService } from "@noddle/deploy";
import type { DomainRoute } from "@noddle/proxy-config";
import {
  pushImage,
  type RegistryConfig,
  registryImageTag,
} from "@noddle/registry";
import { decryptSecret, secretContext } from "@noddle/shared/crypto";
import { markFailed } from "@noddle/shared/lifecycle";
import { swarmServiceName } from "@noddle/shared/swarm-names";
import { disconnect } from "@noddle/ssh-executor";
import { watchUntilFor } from "@noddle/swarm-ops";
import { and, desc, eq, isNotNull, ne } from "drizzle-orm";
import { type DeployClients, withDeployClients } from "#job-run";
import { createLogSink } from "#log-sink";
import { notify } from "#notify";
import { resolveRegistry } from "#registry";
import {
  BUILD_ROOT,
  type BuildOptions,
  type DeployContext,
  type RouteOptions,
} from "#runtime-context";

/**
 * Any deployment still "under watch" for this service stops being watched as
 * soon as ANOTHER deployment becomes the current one: its window no longer
 * covers the version actually serving. Leaving it active derails detection —
 * a crash of the NEW deployment then reads as a loop of the OLD one, since
 * `inspectServiceHealth` checks the Swarm service's name, not which
 * deployment produced which task. Measured: `verify-watch.ts` failed through
 * exactly this path, an earlier version that was actually healthy declared
 * to be crash-looping instead of the real culprit.
 */
async function clearSupersededWatch(
  db: Database,
  serviceId: string,
  currentDeploymentId: string
): Promise<void> {
  await db
    .update(deployments)
    .set({ watchUntil: null })
    .where(
      and(
        eq(deployments.serviceId, serviceId),
        ne(deployments.id, currentDeploymentId),
        isNotNull(deployments.watchUntil)
      )
    );
}

type RunDeployment = NonNullable<
  Awaited<ReturnType<typeof loadDeploymentForRun>>
>;

function loadDeploymentForRun(ctx: DeployContext, deploymentId: string) {
  return ctx.db.query.deployments.findFirst({
    where: eq(deployments.id, deploymentId),
    with: {
      service: { with: { domains: true, envVars: true, server: true } },
    },
  });
}

function routeHosts(
  domains: {
    certificateType: "none" | "letsencrypt";
    host: string;
    https: boolean;
    internalPath: string | null;
    path: string;
    stripPath: boolean;
  }[]
): DomainRoute[] {
  return domains.map((d) => ({
    certificateType: d.certificateType,
    host: d.host,
    https: d.https,
    internalPath: d.internalPath,
    path: d.path,
    stripPath: d.stripPath,
  }));
}

/**
 * Clone, build, push, and roll out — everything that needs the SSH
 * connection. Hoisted out of `runDeploy` so the guard's closure does not
 * push an already dense function past the complexity ceiling.
 */
async function buildAndDeployService(
  ctx: DeployContext,
  route: RouteOptions,
  registry: RegistryConfig | undefined,
  deployment: RunDeployment,
  sink: Awaited<ReturnType<typeof createLogSink>>,
  stream: { onStderr: (s: string) => void; onStdout: (s: string) => void },
  clients: DeployClients
): Promise<void> {
  const { db } = ctx;
  const { service } = deployment;
  const { server } = service;
  const { buildClient, buildDocker, managerDocker } = clients;

  if (!service.gitRepoUrl) {
    throw new Error(
      "service has no git repository: this source_type is not supported here"
    );
  }

  // The cap is derived from the server's memory MINUS what the control
  // plane already occupies: under the chosen topology, it shares the
  // machine.
  const cap = computeBuildCap({ totalMemoryMb: server.totalMemoryMb ?? 2048 });
  sink.write(`▸ build capped at ${cap.memory}\n`);
  await ensureCappedBuilder(buildClient, "noddle-builder", cap, stream);

  const workDir = `${BUILD_ROOT}/${service.id}`;
  const sha = await fetchSource(buildClient, {
    branch: service.gitBranch ?? "main",
    commitSha: deployment.commitSha ?? undefined,
    dir: workDir,
    repoUrl: service.gitRepoUrl,
    ...stream,
  });

  // The tag carries the registry's host when there is one — and this
  // prefix isn't decorative: it's what Docker reads to know where to pull
  // from, so it's what carries the fact "this image is portable". It's
  // written as-is into history, and that's what will later allow deciding a
  // rollback's placement without guessing anything.
  // The Swarm name, not `services.name`: database uniqueness is per
  // environment, Swarm's is global. See `swarmServiceName`.
  // The registry repository follows the same name, for the same reason.
  const swarmName = swarmServiceName(service);
  const version = `${sha.slice(0, 12)}-${Date.now()}`;
  const imageTag = registry
    ? registryImageTag(registry, swarmName, version)
    : `${swarmName}:${version}`;
  await db
    .update(deployments)
    .set({ commitSha: sha, imageTag, status: "deploying" })
    .where(eq(deployments.id, deployment.id));

  if (service.buildMethod === "dockerfile") {
    sink.write("▸ building from Dockerfile\n");
    await buildImageFromDockerfile(buildClient, {
      builderName: "noddle-builder",
      contextDir: workDir,
      dockerfilePath: "Dockerfile",
      imageTag,
      ...stream,
    });
  } else {
    if (service.publishDirectory) {
      sink.write(`▸ static output: ${service.publishDirectory}\n`);
    }
    await buildImage(buildClient, {
      builderName: "noddle-builder",
      dir: workDir,
      imageTag,
      publishDirectory: service.publishDirectory,
      ...stream,
    });
  }

  if (registry) {
    sink.write("▸ pushing image to the registry\n");
    // `removeLocal`: the build node stops accumulating. The image now lives
    // in the registry, and Swarm will pull it from there — including on
    // this very node if it's the one running it.
    await pushImage(buildClient, registry, {
      imageTag,
      removeLocal: true,
      ...stream,
    });
  }

  const env: Record<string, string> = {};
  for (const v of service.envVars) {
    env[v.key] = decryptSecret(
      v.valueEncrypted,
      ctx.appKey,
      secretContext.envVar(v.id)
    );
  }

  sink.write("▸ Swarm rollout\n");
  const outcome = await rolloutService({
    buildDocker,
    certResolver: route.certResolver,
    domainRoutes: routeHosts(service.domains),
    env,
    image: imageTag,
    managerDocker,
    networkName: route.networkName,
    port: service.port,
    registry,
    serviceName: swarmName,
    swarmNodeId: server.swarmNodeId,
  });

  const finishedAt = new Date();

  // THE point that decides everything. `docker service update` returns 0
  // even after a rollback: trusting the exit code would show a green
  // deployment while the old version is still serving.
  if (!outcome.accepted) {
    sink.write(
      `✗ Swarm rolled the update back (${outcome.updateState}) — the previous version is still serving\n`
    );
    await db
      .update(deployments)
      .set({
        errorMessage: outcome.updateMessage,
        finishedAt,
        status: "rolled_back",
        swarmUpdateState: outcome.updateState,
      })
      .where(eq(deployments.id, deployment.id));
    await db
      .update(services)
      .set({ status: "crashed" })
      .where(eq(services.id, service.id));
    await notify(ctx, {
      detail: outcome.updateMessage ?? undefined,
      resource: service.name,
      type: "deploy_reverted",
    });
    return;
  }

  sink.write("✓ deployment accepted\n");
  // Where the task ACTUALLY runs, not where we requested it. With a
  // portable image, Swarm made the choice: the dashboard must display its
  // choice, not our intent.
  await db
    .update(deployments)
    .set({
      finishedAt,
      nodeId: outcome.nodeId,
      status: "succeeded",
      swarmUpdateState: outcome.updateState,
      // Swarm's guarantee expires with its monitor window. From here on,
      // Noddle's own watch covers late crashes.
      watchUntil: watchUntilFor(finishedAt),
    })
    .where(eq(deployments.id, deployment.id));

  await db
    .update(services)
    .set({ currentDeploymentId: deployment.id, status: "running" })
    .where(eq(services.id, service.id));
  await clearSupersededWatch(db, service.id, deployment.id);
  await notify(ctx, {
    detail: deployment.commitSha ?? undefined,
    resource: service.name,
    type: "deploy_succeeded",
  });
}

export async function runDeploy(
  ctx: DeployContext,
  route: RouteOptions,
  build: BuildOptions,
  data: { deploymentId: string }
): Promise<void> {
  const { db } = ctx;

  const deployment = await loadDeploymentForRun(ctx, data.deploymentId);
  if (!deployment) {
    throw new Error(`deployment not found: ${data.deploymentId}`);
  }

  const { service } = deployment;
  const registry = await resolveRegistry({
    appKey: ctx.appKey,
    db,
    embedded: ctx.registry,
    registryId: service.registryId,
  });
  const startedAt = new Date();

  await db
    .update(deployments)
    .set({ startedAt, status: "building" })
    .where(eq(deployments.id, deployment.id));

  let sink: Awaited<ReturnType<typeof createLogSink>> | undefined;
  try {
    sink = await createLogSink({
      deploymentId: deployment.id,
      onChunk: (c) => build.onLog?.(deployment.id, c),
      root: build.logRoot,
    });
    const log = sink;
    const stream = { onStderr: log.write, onStdout: log.write };
    // The connection lives inside `withDeployClients`; a failure to connect
    // is caught the same way as any other failure below.
    await withDeployClients(ctx, service.server, (clients) =>
      buildAndDeployService(
        ctx,
        route,
        registry,
        deployment,
        log,
        stream,
        clients
      )
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sink?.write(`✗ ${message}\n`);
    await db
      .update(deployments)
      .set({
        errorMessage: message,
        finishedAt: new Date(),
        status: "failed",
      })
      .where(eq(deployments.id, deployment.id));
    await db
      .update(services)
      .set(markFailed(null, message))
      .where(eq(services.id, service.id));
    await notify(ctx, {
      detail: message,
      resource: service.name,
      type: "deploy_failed",
    });
    throw err;
  } finally {
    if (sink) {
      const { byteSize, storageUrl } = await sink.close();
      await db
        .insert(deploymentLogs)
        .values({ byteSize, deploymentId: deployment.id, storageUrl });
    }
  }
}

/** Redeploys an already-built image — rollback, or watch-triggered recovery. */
export async function redeployImage(
  ctx: DeployContext,
  route: RouteOptions,
  opts: {
    serviceId: string;
    imageTag: string;
    trigger: "rollback" | "watch_revert";
  }
): Promise<string> {
  const service = await ctx.db.query.services.findFirst({
    where: eq(services.id, opts.serviceId),
    with: { domains: true, envVars: true, server: true },
  });
  if (!service) {
    throw new Error(`service not found: ${opts.serviceId}`);
  }

  const registry = await resolveRegistry({
    appKey: ctx.appKey,
    db: ctx.db,
    embedded: ctx.registry,
    registryId: service.registryId,
  });

  const origin = await ctx.db.query.deployments.findFirst({
    orderBy: desc(deployments.createdAt),
    where: and(
      eq(deployments.serviceId, service.id),
      eq(deployments.imageTag, opts.imageTag)
    ),
  });

  const [created] = await ctx.db
    .insert(deployments)
    .values({
      commitSha: origin?.commitSha ?? null,
      imageTag: opts.imageTag,
      serviceId: service.id,
      status: "deploying",
      trigger: opts.trigger,
    })
    .returning();

  return await withDeployClients(
    ctx,
    service.server,
    async ({ buildDocker, managerDocker }) => {
      const env: Record<string, string> = {};
      for (const v of service.envVars) {
        env[v.key] = decryptSecret(
          v.valueEncrypted,
          ctx.appKey,
          secretContext.envVar(v.id)
        );
      }

      const swarmName = swarmServiceName(service);
      const outcome = await rolloutService({
        buildDocker,
        certResolver: route.certResolver,
        domainRoutes: routeHosts(service.domains),
        env,
        image: opts.imageTag,
        managerDocker,
        networkName: route.networkName,
        port: service.port,
        registry,
        serviceName: swarmName,
        swarmNodeId: service.server.swarmNodeId,
      });

      await ctx.db
        .update(deployments)
        .set({
          finishedAt: new Date(),
          nodeId: outcome.nodeId,
          status: outcome.accepted ? "succeeded" : "rolled_back",
          swarmUpdateState: outcome.updateState,
        })
        .where(eq(deployments.id, created?.id ?? ""));

      if (outcome.accepted && created) {
        await ctx.db
          .update(services)
          .set({ currentDeploymentId: created.id, status: "running" })
          .where(eq(services.id, service.id));
        await clearSupersededWatch(ctx.db, service.id, created.id);
      }

      return created?.id ?? "";
    }
  );
}

/** Reads back the server's memory to size the cap. Idempotent. */
export async function refreshServerFacts(
  ctx: DeployContext,
  serverId: string
): Promise<void> {
  const server = await ctx.db.query.servers.findFirst({
    where: eq(servers.id, serverId),
  });
  if (!server) {
    return;
  }
  const client = await ctx.connectTo(server);
  try {
    const docker = ctx.createDockerApi(client);
    const info = (await docker.info()) as { MemTotal?: number };
    const version = (await docker.version()) as {
      ApiVersion?: string;
      MinAPIVersion?: string;
      Version?: string;
    };
    await ctx.db
      .update(servers)
      .set({
        dockerApiMinVersion: version.MinAPIVersion ?? null,
        dockerVersion: version.Version ?? null,
        status: "connected",
        totalMemoryMb: info.MemTotal
          ? Math.round(info.MemTotal / 1024 / 1024)
          : null,
      })
      .where(eq(servers.id, server.id));
  } finally {
    disconnect(client);
  }
}
