import { randomUUID } from "node:crypto";

import {
  buildImageFromDockerfile,
  computeBuildCap,
  ensureCappedBuilder,
  fetchSource,
} from "@noddle/build-engine";
import {
  stackDeploymentLogs,
  stackDeployments,
  stacks,
} from "@noddle/db/schema";
import {
  injectDeployConfig,
  parseCompose,
  SAFE_COMPOSE_KEY,
} from "@noddle/deploy-engine";
import type {
  ComposeBuildSpec,
  ComposeFile,
  ComposeService,
} from "@noddle/deploy-engine";
import { execArgv, writeRemoteFile } from "@noddle/ssh-executor";
import type { SshClient } from "@noddle/ssh-executor";
import {
  awaitSwarmVerdict,
  ensureOverlayNetwork,
  getSwarmNodeId,
} from "@noddle/swarm-ops";
import { eq } from "drizzle-orm";
import { stringify as stringifyYaml } from "yaml";

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

interface DeployStackResult {
  accepted: boolean;
  swarmUpdateStates: Record<string, string | null>;
}

async function writeAndDeployStack(
  route: RouteOptions,
  opts: {
    createDockerApi: DeployContext["createDockerApi"];
    doc: ComposeFile;
    managerClient: SshClient;
    stackName: string;
    stream?: { onStderr: (s: string) => void; onStdout: (s: string) => void };
  }
): Promise<DeployStackResult> {
  const { createDockerApi, managerClient, stackName, doc } = opts;
  const stream = opts.stream ?? {
    onStderr: () => {},
    onStdout: () => {},
  };
  const managerDocker = createDockerApi(managerClient);
  await ensureOverlayNetwork(managerDocker, route.networkName);

  const serviceKeys = Object.keys(doc.services ?? {});

  const existingList = await managerDocker.listServices({
    filters: JSON.stringify({ name: [stackName] }),
  });
  const existing = new Set(
    existingList.map((s) => s.Spec?.Name).filter((n): n is string => Boolean(n))
  );

  const tmpPath = `/tmp/noddle-stack-${randomUUID()}.yml`;
  await writeRemoteFile(managerClient, tmpPath, stringifyYaml(doc));

  try {
    const result = await execArgv(
      managerClient,
      [
        "sudo",
        "docker",
        "stack",
        "deploy",
        "--resolve-image",
        "never",
        "-c",
        tmpPath,
        stackName,
      ],
      stream
    );
    if (result.code !== 0) {
      throw new Error(
        `docker stack deploy failed (code ${result.code})\n${(result.stderr || result.stdout).trim()}`
      );
    }

    const swarmUpdateStates: Record<string, string | null> = {};
    let accepted = true;
    for (const key of serviceKeys) {
      const swarmName = `${stackName}_${key}`;
      const verdict = await awaitSwarmVerdict(managerDocker, swarmName, {
        created: !existing.has(swarmName),
      });
      swarmUpdateStates[key] = verdict.updateState;
      if (!verdict.accepted) {
        accepted = false;
      }
    }
    return { accepted, swarmUpdateStates };
  } finally {
    await execArgv(managerClient, ["rm", "-f", tmpPath]).catch(() => {});
  }
}

async function buildComposeServices(opts: {
  buildClient: SshClient;
  onServiceStart: (key: string) => void;
  services: Record<string, ComposeService>;
  sha: string;
  stackName: string;
  stream: { onStderr: (s: string) => void; onStdout: (s: string) => void };
  workDir: string;
}): Promise<Record<string, string>> {
  const serviceImages: Record<string, string> = {};

  for (const [key, svc] of Object.entries(opts.services)) {
    if (!SAFE_COMPOSE_KEY.test(key)) {
      throw new Error(`compose service name refused: ${JSON.stringify(key)}`);
    }
    if (!svc.build) {
      continue;
    }
    const buildSpec: ComposeBuildSpec =
      typeof svc.build === "string" ? { context: svc.build } : svc.build;
    const contextDir = `${opts.workDir}/${buildSpec.context ?? "."}`;
    const dockerfilePath = buildSpec.dockerfile ?? "Dockerfile";
    const imageTag = `${opts.stackName}-${key}:${opts.sha.slice(0, 12)}-${Date.now()}`;

    opts.onServiceStart(key);
    await buildImageFromDockerfile(opts.buildClient, {
      contextDir,
      dockerfilePath,
      imageTag,
      ...opts.stream,
    });

    serviceImages[key] = imageTag;
    const { build: _build, ...rest } = svc;
    opts.services[key] = { ...rest, image: imageTag };
  }

  return serviceImages;
}

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
  stream: { onStderr: (s: string) => void; onStdout: (s: string) => void },
  clients: DeployClients
): Promise<void> {
  const { db } = ctx;
  const { stack } = deployment;
  const { server } = stack;
  const { buildClient, buildDocker, managerClient } = clients;

  const cap = computeBuildCap({ totalMemoryMb: server.totalMemoryMb ?? 2048 });
  sink.write(`▸ build capped at ${cap.memory}\n`);
  await ensureCappedBuilder(buildClient, cap, stream);

  const workDir = `${BUILD_ROOT}/stacks/${stack.id}`;
  const sha = await fetchSource(buildClient, {
    branch: stack.gitBranch,
    commitSha: deployment.commitSha ?? undefined,
    dir: workDir,
    repoUrl: stack.gitRepoUrl,
    ...stream,
  });
  await db
    .update(stackDeployments)
    .set({ commitSha: sha })
    .where(eq(stackDeployments.id, deployment.id));

  const composePath = `${workDir}/${stack.composeFilePath}`;
  const catResult = await execArgv(buildClient, ["cat", composePath]);
  if (catResult.code !== 0) {
    throw new Error(`compose file not found: ${stack.composeFilePath}`);
  }
  const rawText = catResult.stdout;
  await db
    .update(stackDeployments)
    .set({ composeSource: rawText })
    .where(eq(stackDeployments.id, deployment.id));

  const doc = parseCompose(rawText, stack.composeFilePath);
  const services = doc.services ?? {};

  sink.write("▸ building services\n");
  const serviceImages = await buildComposeServices({
    buildClient,
    onServiceStart: (key) => sink.write(`▸ ${key}\n`),
    services,
    sha,
    stackName: stack.swarmName,
    stream,
    workDir,
  });

  await db
    .update(stackDeployments)
    .set({ serviceImages, status: "deploying" })
    .where(eq(stackDeployments.id, deployment.id));

  const placementNodeId =
    server.swarmNodeId ?? (await getSwarmNodeId(buildDocker));

  injectDeployConfig(doc, {
    builtKeys: Object.keys(serviceImages),
    certResolver: route.certResolver,
    domains: stack.domain ? [stack.domain] : undefined,
    networkName: route.networkName,
    placementNodeId,
    port: stack.port,
    publicService: stack.publicService,
    stackName: stack.swarmName,
  });

  sink.write("▸ Swarm rollout (docker stack deploy)\n");
  const { accepted, swarmUpdateStates } = await writeAndDeployStack(route, {
    createDockerApi: ctx.createDockerApi,
    doc,
    managerClient,
    stackName: stack.swarmName,
    stream,
  });

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
    const stream = { onStderr: log.write, onStdout: log.write };
    await withDeployClients(ctx, stack.server, (clients) =>
      buildAndDeployStack(ctx, route, deployment, log, stream, clients)
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

  return await withDeployClients(
    ctx,
    stack.server,
    async ({ buildDocker, managerClient }) => {
      const doc = parseCompose(composeSource, stack.composeFilePath);
      const services = doc.services ?? {};
      const serviceImages = (source.serviceImages ?? {}) as Record<
        string,
        string
      >;
      for (const [key, tag] of Object.entries(serviceImages)) {
        const svc = services[key];
        if (svc) {
          const { build: _build, ...rest } = svc;
          services[key] = { ...rest, image: tag };
        }
      }

      const placementNodeId =
        stack.server.swarmNodeId ?? (await getSwarmNodeId(buildDocker));

      injectDeployConfig(doc, {
        builtKeys: Object.keys(serviceImages),
        certResolver: route.certResolver,
        domains: stack.domain ? [stack.domain] : undefined,
        networkName: route.networkName,
        placementNodeId,
        port: stack.port,
        publicService: stack.publicService,
        stackName: stack.swarmName,
      });

      const { accepted, swarmUpdateStates } = await writeAndDeployStack(route, {
        createDockerApi: ctx.createDockerApi,
        doc,
        managerClient,
        stackName: stack.swarmName,
      });

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
    }
  );
}
