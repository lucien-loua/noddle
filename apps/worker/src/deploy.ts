import {
  buildImage,
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
import { routeLabels } from "@noddle/proxy-config";
import { decryptSecret, secretContext } from "@noddle/shared/crypto";
import { swarmServiceName } from "@noddle/shared/swarm-names";
import { disconnect, dockerClient, type SshClient } from "@noddle/ssh-executor";
import {
  deployService,
  ensureOverlayNetwork,
  getSwarmNodeId,
  isDeployAccepted,
  type RegistryAuth,
  readRunningNodeId,
  watchUntilFor,
} from "@noddle/swarm-ops";
import { and, desc, eq, isNotNull, ne } from "drizzle-orm";
import { createLogSink } from "#log-sink";
import { notify } from "#notify";
import {
  isPortableImage,
  pushImage,
  type RegistryConfig,
  registryImageTag,
  resolveRegistry,
} from "#registry";
import {
  BUILD_ROOT,
  type BuildOptions,
  connectForDeploy,
  connectTo,
  type DeployContext,
  type RouteOptions,
  type ServerRow,
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

/**
 * Should this image be pinned to a node, and which one?
 *
 * THE question behind this whole effort, and it's decided image by image —
 * never by a global setting.
 *
 * A registry image is reachable from any node: no constraint, Swarm places
 * it wherever it wants, and that's the whole point. A local image exists
 * ONLY on the node that built it: without a constraint, the scheduler would
 * pick another one and the task would never start.
 *
 * This is what makes the migration free. A rollback to a deployment from
 * before the registry carries an unqualified tag, so it stays pinned to the
 * right node and keeps working, while new deployments are free to move.
 * Nothing to re-push, nothing to rewrite in history.
 */
async function placementFor(opts: {
  buildDocker: ReturnType<typeof dockerClient>;
  image: string;
  registry: RegistryConfig | undefined;
  server: ServerRow;
}): Promise<string | undefined> {
  if (isPortableImage(opts.image, opts.registry)) {
    return;
  }
  // Any NON-portable image is pinned, no exceptions.
  //
  // The previous code skipped the constraint when the service's server WAS
  // the manager (`sameConnection`), treating it as a no-op — which is only
  // true on a SINGLE-node cluster. As soon as a worker joins, a service
  // hosted on the manager ended up without a constraint even though its
  // image only exists there: the scheduler could place it on the worker,
  // where the task would never start. A gap predating this effort —
  // `verify-multi.ts` builds on the WORKER, so that case was never exercised.
  //
  // On a single-node cluster, the constraint points at that node: it has no
  // effect, and that's the honest cost of a rule with no exceptions.
  //
  // `swarmNodeId` has been recorded at provisioning since Phase 4; the
  // `docker info` fallback covers servers registered before the column
  // existed. It's a LOCAL read, which a worker node answers correctly about
  // itself.
  return opts.server.swarmNodeId ?? (await getSwarmNodeId(opts.buildDocker));
}

/** What Swarm distributes to its agents so THEY can pull. */
function authFor(
  registry: RegistryConfig | undefined
): RegistryAuth | undefined {
  if (!registry) {
    return;
  }
  return {
    password: registry.password,
    serveraddress: registry.host,
    username: registry.username,
  };
}

export async function runDeploy(
  ctx: DeployContext,
  route: RouteOptions,
  build: BuildOptions,
  data: { deploymentId: string }
): Promise<void> {
  const { db } = ctx;

  const deployment = await db.query.deployments.findFirst({
    where: eq(deployments.id, data.deploymentId),
    with: { service: { with: { envVars: true, server: true } } },
  });
  if (!deployment) {
    throw new Error(`deployment not found: ${data.deploymentId}`);
  }

  const { service } = deployment;
  const { server } = service;
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

  const sink = await createLogSink({
    deploymentId: deployment.id,
    onChunk: (c) => build.onLog?.(deployment.id, c),
    root: build.logRoot,
  });
  const stream = { onStderr: sink.write, onStdout: sink.write };

  let buildClient: SshClient | undefined;
  let managerClient: SshClient | undefined;

  try {
    if (!service.gitRepoUrl) {
      throw new Error(
        "service has no git repository: this source_type is not supported here"
      );
    }

    let sameConnection: boolean;
    ({ buildClient, managerClient, sameConnection } = await connectForDeploy(
      ctx,
      server
    ));

    // The cap is derived from the server's memory MINUS what the control
    // plane already occupies: under the chosen topology, it shares the
    // machine.
    const cap = computeBuildCap({
      totalMemoryMb: server.totalMemoryMb ?? 2048,
    });
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
    // written as-is into history, and that's what will later allow deciding
    // a rollback's placement without guessing anything.
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

    await buildImage(buildClient, {
      builderName: "noddle-builder",
      dir: workDir,
      imageTag,
      ...stream,
    });

    if (registry) {
      sink.write("▸ pushing image to the registry\n");
      // `removeLocal`: the build node stops accumulating. The image now
      // lives in the registry, and Swarm will pull it from there — including
      // on this very node if it's the one running it.
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

    const buildDocker = dockerClient(buildClient);
    // Free if the image is in the registry, pinned to the build node
    // otherwise — decided on the image reference, never on a setting.
    const placementNodeId = await placementFor({
      buildDocker,
      image: imageTag,
      registry,
      server,
    });

    const managerDocker = sameConnection
      ? buildDocker
      : dockerClient(managerClient);
    await ensureOverlayNetwork(managerDocker, route.networkName);

    sink.write("▸ Swarm rollout\n");
    const outcome = await deployService(managerDocker, {
      env,
      image: imageTag,
      labels: routeLabels({
        certResolver: route.certResolver,
        domain: service.domain ?? undefined,
        port: service.port,
        serviceName: swarmName,
      }),
      networkName: route.networkName,
      placementNodeId,
      port: service.port,
      registryAuth: authFor(registry),
      serviceName: swarmName,
    });

    const finishedAt = new Date();

    // THE point that decides everything. `docker service update` returns 0
    // even after a rollback: trusting the exit code would show a green
    // deployment while the old version is still serving.
    if (!isDeployAccepted(outcome.updateState)) {
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
    const nodeId = await readRunningNodeId(managerDocker, swarmName);
    await db
      .update(deployments)
      .set({
        finishedAt,
        nodeId,
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
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sink.write(`✗ ${message}\n`);
    await db
      .update(deployments)
      .set({
        errorMessage: message,
        finishedAt: new Date(),
        status: "failed",
      })
      .where(eq(deployments.id, deployment.id));
    await notify(ctx, {
      detail: message,
      resource: service.name,
      type: "deploy_failed",
    });
    throw err;
  } finally {
    // Object identity, not `sameConnection`: that variable is scoped to the
    // `try` block to avoid a false-positive Biome warning about reassigning
    // an outer `let` through destructuring. Identity is the real invariant
    // anyway: never close the SAME connection twice.
    if (managerClient && managerClient !== buildClient) {
      disconnect(managerClient);
    }
    if (buildClient) {
      disconnect(buildClient);
    }
    // A POINTER to the file, never the log text, is stored in the database.
    const { byteSize, storageUrl } = await sink.close();
    await db
      .insert(deploymentLogs)
      .values({ byteSize, deploymentId: deployment.id, storageUrl });
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
    with: { envVars: true, server: true },
  });
  if (!service) {
    throw new Error(`service not found: ${opts.serviceId}`);
  }
  // The SERVICE's registry, not the installation's: the replayed tag is
  // qualified by the host holding the image, and that's the one that must
  // appear in the auth distributed to agents.
  const registry = await resolveRegistry({
    appKey: ctx.appKey,
    db: ctx.db,
    embedded: ctx.registry,
    registryId: service.registryId,
  });

  // The commit this image carries, taken from the deployment that built it.
  //
  // Without this, the "rolled back" row in history shows "—" for commit: the
  // dashboard knows which IMAGE is running but no longer which CODE, and
  // "which commit is in production?" is exactly the question you ask right
  // after a rollback.
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

  // No build here: the image already exists on ITS server. The Swarm
  // command, however, still has to go through the manager — and the
  // placement constraint targets the service's server, not the one
  // receiving the command.
  const { buildClient, managerClient, sameConnection } = await connectForDeploy(
    ctx,
    service.server
  );

  try {
    const env: Record<string, string> = {};
    for (const v of service.envVars) {
      env[v.key] = decryptSecret(
        v.valueEncrypted,
        ctx.appKey,
        secretContext.envVar(v.id)
      );
    }

    const buildDocker = dockerClient(buildClient);
    // THIS is where the migration plays out. An image from BEFORE the
    // registry carries an unqualified tag: it only exists on the node that
    // built it, so it stays pinned there and the rollback works as before.
    // A registry image is free. Neither case requires knowing which one it
    // is — the reference tells us.
    const placementNodeId = await placementFor({
      buildDocker,
      image: opts.imageTag,
      registry,
      server: service.server,
    });
    const managerDocker = sameConnection
      ? buildDocker
      : dockerClient(managerClient);

    // No build: the image already exists. This is precisely what makes the
    // rollback instant, and possible to ANY version in history — Swarm
    // itself only keeps one previous spec.
    const swarmName = swarmServiceName(service);
    const outcome = await deployService(managerDocker, {
      env,
      image: opts.imageTag,
      labels: routeLabels({
        certResolver: route.certResolver,
        domain: service.domain ?? undefined,
        port: service.port,
        serviceName: swarmName,
      }),
      networkName: route.networkName,
      placementNodeId,
      port: service.port,
      registryAuth: authFor(registry),
      serviceName: swarmName,
    });

    const accepted = isDeployAccepted(outcome.updateState);
    await ctx.db
      .update(deployments)
      .set({
        finishedAt: new Date(),
        nodeId: accepted
          ? await readRunningNodeId(managerDocker, swarmName)
          : null,
        status: accepted ? "succeeded" : "rolled_back",
        swarmUpdateState: outcome.updateState,
      })
      .where(eq(deployments.id, created?.id ?? ""));

    if (accepted && created) {
      await ctx.db
        .update(services)
        .set({ currentDeploymentId: created.id, status: "running" })
        .where(eq(services.id, service.id));
      await clearSupersededWatch(ctx.db, service.id, created.id);
    }

    return created?.id ?? "";
  } finally {
    if (!sameConnection) {
      disconnect(managerClient);
    }
    disconnect(buildClient);
  }
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
  const client = await connectTo(ctx, server);
  try {
    const docker = dockerClient(client);
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
