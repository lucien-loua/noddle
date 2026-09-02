import {
  buildImage,
  buildImageFromDockerfile,
  computeBuildCap,
  ensureCappedBuilder,
  fetchSource,
  resolveBuildDir,
} from "@noddle/build-engine";
import { decryptSecret, secretContext } from "@noddle/crypto";
import {
  deploymentLogs,
  deployments,
  servers,
  services,
} from "@noddle/db/schema";
import type { DomainRoute } from "@noddle/proxy-config";
import { pushImage, registryImageTag } from "@noddle/registry";
import type { RegistryConfig } from "@noddle/registry";
import { redactUrlCredentials } from "@noddle/shared/redact";
import { swarmServiceName } from "@noddle/shared/swarm-names";
import { disconnect } from "@noddle/ssh-executor";
import { and, desc, eq } from "drizzle-orm";

import {
  recordAcceptedService,
  recordFailedService,
  recordRefusedService,
} from "#deploy/accepted-deployment";
import { providerCloneUrl } from "#deploy/provider-clone";
import { rolloutService } from "#deploy/rollout";
import { withDeployClients } from "#job-run";
import type { DeployClients } from "#job-run";
import { createLogSink } from "#log-sink";
import { notify } from "#notify";
import { resolveRegistry } from "#registry";
import { BUILD_ROOT } from "#runtime-context";
import type {
  BuildOptions,
  DeployContext,
  RouteOptions,
} from "#runtime-context";

type RunDeployment = NonNullable<
  Awaited<ReturnType<typeof loadDeploymentForRun>>
>;

function loadDeploymentForRun(ctx: DeployContext, deploymentId: string) {
  return ctx.db.query.deployments.findFirst({
    where: eq(deployments.id, deploymentId),
    with: {
      service: {
        with: {
          deployKey: true,
          domains: true,
          envVars: true,
          gitProvider: true,
          server: true,
        },
      },
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

async function sourceCredentials(
  ctx: DeployContext,
  service: RunDeployment["service"],
  sink: Awaited<ReturnType<typeof createLogSink>>
): Promise<{ deployKey: string | null; repoUrl: string | null }> {
  const repoUrl = await providerCloneUrl(ctx, service);
  if (repoUrl) {
    sink.write(`▸ cloning through ${service.gitProvider?.name}\n`);
    return { deployKey: null, repoUrl };
  }

  const overHttps = service.gitRepoUrl?.startsWith("https://") ?? false;

  if (!service.deployKey) {
    if (overHttps) {
      sink.write("▸ cloning anonymously: no git provider, no deploy key\n");
    }
    return { deployKey: null, repoUrl: null };
  }

  sink.write(`▸ authenticating as ${service.deployKey.name}\n`);
  if (overHttps) {
    sink.write(
      "▸ a deploy key is only used over SSH: this https URL clones anonymously\n"
    );
  }
  return {
    deployKey: decryptSecret(
      service.deployKey.privateKeyEncrypted,
      ctx.appKey,
      secretContext.sshKey(service.deployKey.id)
    ),
    repoUrl: null,
  };
}

async function buildAndPushImage(
  service: RunDeployment["service"],
  imageTag: string,
  registry: RegistryConfig | undefined,
  buildClient: DeployClients["buildClient"],
  sink: Awaited<ReturnType<typeof createLogSink>>,
  stream: { onStderr: (s: string) => void; onStdout: (s: string) => void }
): Promise<void> {
  if (service.cleanCache) {
    sink.write("▸ cache disabled for this build\n");
  }

  const buildDir = resolveBuildDir(
    `${BUILD_ROOT}/${service.id}`,
    service.buildPath
  );
  if (service.buildPath) {
    sink.write(`▸ build context: ${service.buildPath}\n`);
  }

  if (service.buildMethod === "dockerfile") {
    sink.write("▸ building from Dockerfile\n");
    await buildImageFromDockerfile(buildClient, {
      contextDir: buildDir,
      dockerfilePath: "Dockerfile",
      imageTag,
      noCache: service.cleanCache,
      ...stream,
    });
  } else {
    if (service.publishDirectory) {
      sink.write(`▸ static output: ${service.publishDirectory}\n`);
    }
    await buildImage(buildClient, {
      dir: buildDir,
      imageTag,
      noCache: service.cleanCache,
      publishDirectory: service.publishDirectory,
      ...stream,
    });
  }

  if (registry) {
    sink.write("▸ pushing image to the registry\n");
    await pushImage(buildClient, registry, {
      imageTag,
      removeLocal: true,
      ...stream,
    });
  }
}

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
  const publishedImage = service.sourceType === "docker_image";

  let imageTag: string;
  let sha: string | null = null;

  if (publishedImage) {
    if (!service.dockerImage) {
      throw new Error("service has no docker image");
    }
    imageTag = service.dockerImage;
    sink.write(`▸ image ${imageTag}\n`);
  } else {
    if (!service.gitRepoUrl) {
      throw new Error(
        "service has no git repository: this source_type is not supported here"
      );
    }

    const cap = computeBuildCap({
      totalMemoryMb: server.totalMemoryMb ?? 2048,
    });
    sink.write(`▸ build capped at ${cap.memory}\n`);
    await ensureCappedBuilder(buildClient, cap, stream);

    const workDir = `${BUILD_ROOT}/${service.id}`;
    const auth = await sourceCredentials(ctx, service, sink);

    sha = await fetchSource(buildClient, {
      branch: service.gitBranch ?? "main",
      commitSha: deployment.commitSha ?? undefined,
      deployKey: auth.deployKey,
      dir: workDir,
      keyScope: service.id,
      repoUrl: auth.repoUrl ?? service.gitRepoUrl,
      submodules: service.gitSubmodules,
      ...stream,
    });

    const builtName = swarmServiceName(service);
    const version = `${sha.slice(0, 12)}-${Date.now()}`;
    imageTag = registry
      ? registryImageTag(registry, builtName, version)
      : `${builtName}:${version}`;
  }

  const swarmName = swarmServiceName(service);
  await db
    .update(deployments)
    .set({ commitSha: sha, imageTag, status: "deploying" })
    .where(eq(deployments.id, deployment.id));

  if (!publishedImage) {
    await buildAndPushImage(
      service,
      imageTag,
      registry,
      buildClient,
      sink,
      stream
    );
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
    portable: publishedImage,
    registry,
    serviceName: swarmName,
    swarmNodeId: server.swarmNodeId,
  });

  const finishedAt = new Date();

  if (!outcome.accepted) {
    sink.write(
      `✗ Swarm rolled the update back (${outcome.updateState}). The previous version is still serving\n`
    );
    await recordRefusedService(db, {
      deploymentId: deployment.id,
      finishedAt,
      nodeId: outcome.nodeId,
      serviceId: service.id,
      swarmUpdateMessage: outcome.updateMessage,
      swarmUpdateState: outcome.updateState,
    });
    await notify(ctx, {
      detail: outcome.updateMessage ?? undefined,
      resource: service.name,
      type: "deploy_reverted",
    });
    return;
  }

  sink.write("✓ deployment accepted\n");
  await recordAcceptedService(db, {
    deploymentId: deployment.id,
    finishedAt,
    nodeId: outcome.nodeId,
    serviceId: service.id,
    swarmUpdateState: outcome.updateState,
  });
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
  const registry =
    service.sourceType === "docker_image" && !service.registryId
      ? undefined
      : await resolveRegistry({
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
  } catch (error) {
    const message = redactUrlCredentials(
      error instanceof Error ? error.message : String(error)
    );
    sink?.write(`✗ ${message}\n`);
    await recordFailedService(db, {
      deploymentId: deployment.id,
      errorMessage: message,
      serviceId: service.id,
    });
    await notify(ctx, {
      detail: message,
      resource: service.name,
      type: "deploy_failed",
    });
    throw error;
  } finally {
    if (sink) {
      const { byteSize, storageUrl } = await sink.close();
      await db
        .insert(deploymentLogs)
        .values({ byteSize, deploymentId: deployment.id, storageUrl });
    }
  }
}

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

  const [registry, origin] = await Promise.all([
    resolveRegistry({
      appKey: ctx.appKey,
      db: ctx.db,
      embedded: ctx.registry,
      registryId: service.registryId,
    }),
    ctx.db.query.deployments.findFirst({
      orderBy: desc(deployments.createdAt),
      where: and(
        eq(deployments.serviceId, service.id),
        eq(deployments.imageTag, opts.imageTag)
      ),
    }),
  ]);

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

      const finishedAt = new Date();
      if (!created) {
        return "";
      }
      if (!outcome.accepted) {
        await recordRefusedService(ctx.db, {
          deploymentId: created.id,
          finishedAt,
          nodeId: outcome.nodeId,
          serviceId: service.id,
          swarmUpdateMessage: outcome.updateMessage,
          swarmUpdateState: outcome.updateState,
        });
        return created.id;
      }
      await recordAcceptedService(ctx.db, {
        deploymentId: created.id,
        finishedAt,
        nodeId: outcome.nodeId,
        serviceId: service.id,
        swarmUpdateState: outcome.updateState,
      });
      return created.id;
    }
  );
}

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
