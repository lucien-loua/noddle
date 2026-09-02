import {
  stackDeploymentLogs,
  stackDeployments,
  stacks,
} from "@noddle/db/schema";
import { shipStack } from "@noddle/deploy-engine";
import type { ShipStackBuild } from "@noddle/deploy-engine";
import { eq } from "drizzle-orm";

import {
  recordAcceptedStack,
  recordFailedStack,
  recordRefusedStack,
} from "#deploy/accepted-deployment";
import { withDeployClients } from "#job-run";
import type { DeployClients } from "#job-run";
import { createLogSink } from "#log-sink";
import type { LogSink } from "#log-sink";
import { notify } from "#notify";
import { BUILD_ROOT } from "#runtime-context";
import type {
  BuildOptions,
  DeployContext,
  RouteOptions,
} from "#runtime-context";

const SAFE_RELATIVE_PATH = /^(?!\/)(?!.*\.\.)[\w./-]+$/;

type StackDeploymentRow = NonNullable<
  Awaited<ReturnType<typeof loadStackDeploymentForRun>>
>;

function loadStackDeploymentForRun(
  ctx: DeployContext,
  stackDeploymentId: string
) {
  return ctx.db.query.stackDeployments.findFirst({
    where: eq(stackDeployments.id, stackDeploymentId),
    with: { stack: { with: { server: true } } },
  });
}

async function buildAndDeployStack(
  ctx: DeployContext,
  route: RouteOptions,
  deployment: StackDeploymentRow,
  sink: LogSink,
  clients: DeployClients
): Promise<void> {
  const { db } = ctx;
  const { stack } = deployment;
  const { server } = stack;

  const build: ShipStackBuild = {
    composeFilePath: stack.composeFilePath,
    kind: "git",
    repoDir: `${BUILD_ROOT}/stacks/${stack.id}`,
    source: {
      branch: stack.gitBranch,
      commitSha: deployment.commitSha ?? undefined,
      repoUrl: stack.gitRepoUrl,
    },
    totalMemoryMb: server.totalMemoryMb ?? 2048,
  };

  const { accepted, swarmUpdateStates } = await shipStack(
    build,
    {
      certResolver: route.certResolver,
      domain: stack.domain ?? undefined,
      networkName: route.networkName,
      port: stack.port,
      publicService: stack.publicService,
      stackName: stack.swarmName,
      swarmNodeId: server.swarmNodeId,
    },
    {
      buildClient: clients.buildClient,
      buildDocker: clients.buildDocker,
      createDockerApi: ctx.createDockerApi,
      managerClient: clients.managerClient,
    },
    {
      onCommitResolved: (commitSha) =>
        db
          .update(stackDeployments)
          .set({ commitSha })
          .where(eq(stackDeployments.id, deployment.id))
          .then(() => undefined),
      onComposeRead: (composeSource) =>
        db
          .update(stackDeployments)
          .set({ composeSource })
          .where(eq(stackDeployments.id, deployment.id))
          .then(() => undefined),
      onLog: sink.write,
      onServicesBuilt: (serviceImages) =>
        db
          .update(stackDeployments)
          .set({ serviceImages, status: "deploying" })
          .where(eq(stackDeployments.id, deployment.id))
          .then(() => undefined),
    }
  );

  const finishedAt = new Date();

  if (!accepted) {
    sink.write(
      "✗ Swarm refused the rollout of at least one service in the stack\n"
    );
    await recordRefusedStack(db, {
      deploymentId: deployment.id,
      finishedAt,
      stackId: stack.id,
      swarmUpdateStates,
    });
    return;
  }

  sink.write("✓ deployment accepted\n");
  await recordAcceptedStack(db, {
    deploymentId: deployment.id,
    finishedAt,
    stackId: stack.id,
    swarmUpdateStates,
  });
}

export async function runStackDeploy(
  ctx: DeployContext,
  route: RouteOptions,
  build: BuildOptions,
  data: { stackDeploymentId: string }
): Promise<void> {
  const { db } = ctx;

  const deployment = await loadStackDeploymentForRun(
    ctx,
    data.stackDeploymentId
  );
  if (!deployment) {
    throw new Error(`stack deployment not found: ${data.stackDeploymentId}`);
  }

  const { stack } = deployment;
  const startedAt = new Date();

  if (!SAFE_RELATIVE_PATH.test(stack.composeFilePath)) {
    throw new Error(
      `compose file path refused: ${JSON.stringify(stack.composeFilePath)}`
    );
  }

  await db
    .update(stackDeployments)
    .set({ startedAt, status: "building" })
    .where(eq(stackDeployments.id, deployment.id));

  let sink: LogSink | undefined;
  try {
    sink = await createLogSink({
      deploymentId: deployment.id,
      onChunk: (c) => build.onLog?.(deployment.id, c),
      root: build.logRoot,
    });
    const log = sink;
    await withDeployClients(ctx, stack.server, (clients) =>
      buildAndDeployStack(ctx, route, deployment, log, clients)
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sink?.write(`✗ ${message}\n`);
    await recordFailedStack(db, {
      deploymentId: deployment.id,
      errorMessage: message,
      stackId: stack.id,
    });
    await notify(ctx, {
      detail: message,
      resource: stack.name,
      type: "deploy_failed",
    });
    throw error;
  } finally {
    if (sink) {
      const { byteSize, storageUrl } = await sink.close();
      await db
        .insert(stackDeploymentLogs)
        .values({ byteSize, stackDeploymentId: deployment.id, storageUrl });
    }
  }
}

export async function redeployStack(
  ctx: DeployContext,
  route: RouteOptions,
  opts: {
    sourceDeploymentId: string;
    stackId: string;
    trigger: "rollback" | "watch_revert";
  }
): Promise<string> {
  const stack = await ctx.db.query.stacks.findFirst({
    where: eq(stacks.id, opts.stackId),
    with: { server: true },
  });
  if (!stack) {
    throw new Error(`stack not found: ${opts.stackId}`);
  }

  const source = await ctx.db.query.stackDeployments.findFirst({
    where: eq(stackDeployments.id, opts.sourceDeploymentId),
  });
  if (!source?.composeSource) {
    throw new Error(
      `source deployment not found or has no saved compose: ${opts.sourceDeploymentId}`
    );
  }
  const { composeSource } = source;

  const [created] = await ctx.db
    .insert(stackDeployments)
    .values({
      commitSha: source.commitSha,
      composeSource,
      serviceImages: source.serviceImages,
      stackId: stack.id,
      status: "deploying",
      trigger: opts.trigger,
    })
    .returning();
  if (!created) {
    throw new Error("could not create stack deployment");
  }

  return await withDeployClients(ctx, stack.server, async (clients) => {
    const serviceImages = (source.serviceImages ?? {}) as Record<
      string,
      string
    >;

    const { accepted, swarmUpdateStates } = await shipStack(
      {
        composeFilePath: stack.composeFilePath,
        composeSource,
        kind: "resolved",
        serviceImages,
      },
      {
        certResolver: route.certResolver,
        domain: stack.domain ?? undefined,
        networkName: route.networkName,
        port: stack.port,
        publicService: stack.publicService,
        stackName: stack.swarmName,
        swarmNodeId: stack.server.swarmNodeId,
      },
      {
        buildClient: clients.buildClient,
        buildDocker: clients.buildDocker,
        createDockerApi: ctx.createDockerApi,
        managerClient: clients.managerClient,
      }
    );

    const finishedAt = new Date();
    if (!accepted) {
      await recordRefusedStack(ctx.db, {
        deploymentId: created.id,
        finishedAt,
        stackId: stack.id,
        swarmUpdateStates,
      });
      return created.id;
    }
    await recordAcceptedStack(ctx.db, {
      deploymentId: created.id,
      finishedAt,
      stackId: stack.id,
      swarmUpdateStates,
    });
    return created.id;
  });
}
