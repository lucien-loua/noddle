import { randomUUID } from "node:crypto";
import {
  buildImageFromDockerfile,
  computeBuildCap,
  ensureCappedBuilder,
  fetchSource,
} from "@noddle/build-engine";
import {
  type ComposeBuildSpec,
  type ComposeFile,
  type ComposeService,
  injectDeployConfig,
  parseCompose,
  SAFE_COMPOSE_KEY,
} from "@noddle/compose-engine";
import type { Database } from "@noddle/db";
import {
  stackDeploymentLogs,
  stackDeployments,
  stacks,
} from "@noddle/db/schema";
import { markCrashed, markRunning, settle } from "@noddle/shared/lifecycle";
import {
  execArgv,
  type SshClient,
  writeRemoteFile,
} from "@noddle/ssh-executor";
import {
  ensureOverlayNetwork,
  getSwarmNodeId,
  isDeployAccepted,
  readUpdateState,
  waitForRunningTask,
  watchUntilFor,
} from "@noddle/swarm-ops";
import { and, eq, isNotNull, ne } from "drizzle-orm";
import { stringify as stringifyYaml } from "yaml";
import { type DeployClients, withDeployClients } from "#job-run";
import { createLogSink, type LogSink } from "#log-sink";
import {
  BUILD_ROOT,
  type BuildOptions,
  type DeployContext,
  type RouteOptions,
} from "#runtime-context";

/** Relative file path, with no escape from the cloned directory. */
const SAFE_RELATIVE_PATH = /^(?!\/)(?!.*\.\.)[\w./-]+$/;

/**
 * Any stack deployment still "under watch" stops being so as soon as
 * ANOTHER deployment becomes the current one — same reason as
 * `clearSupersededWatch` in `deploy.ts`: `inspectServiceHealth` checks a
 * Swarm service name, not which deployment produced which task, and an
 * otherwise healthy earlier stack would otherwise get blamed for a more
 * recent stack's crash.
 */
async function clearSupersededStackWatch(
  db: Database,
  stackId: string,
  currentDeploymentId: string
): Promise<void> {
  await db
    .update(stackDeployments)
    .set({ watchUntil: null })
    .where(
      and(
        eq(stackDeployments.stackId, stackId),
        ne(stackDeployments.id, currentDeploymentId),
        isNotNull(stackDeployments.watchUntil)
      )
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// SSH / Swarm orchestration (parse + inject live in @noddle/compose-engine)
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Write + `docker stack deploy` + per-service read-back
// ─────────────────────────────────────────────────────────────────────────────

interface DeployStackResult {
  accepted: boolean;
  swarmUpdateStates: Record<string, string | null>;
}

/**
 * `docker stack deploy` returns as soon as Swarm has accepted the specs,
 * NOT when the tasks converge — exactly like `docker service update`, only
 * worse: a single exit code for N services. So we read each one back
 * separately, with the same polling as the single-service path
 * (`waitForRunningTask` on a creation, `readUpdateState` always).
 */
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
    onStderr: () => undefined,
    onStdout: () => undefined,
  };
  const managerDocker = createDockerApi(managerClient);
  await ensureOverlayNetwork(managerDocker, route.networkName);

  const serviceKeys = Object.keys(doc.services ?? {});

  // Docker filters by PREFIX (already noted in swarm.ts): sufficient here,
  // a stack name is unique by construction (unique index in the database).
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
      if (!existing.has(swarmName)) {
        // biome-ignore lint/performance/noAwaitInLoops: sequential polling, one service after another — parallelizing would mix independent services' convergence logs
        await waitForRunningTask(managerDocker, swarmName);
      }
      const state = await readUpdateState(managerDocker, swarmName);
      swarmUpdateStates[key] = state.updateState;
      if (!isDeployAccepted(state.updateState)) {
        accepted = false;
      }
    }
    return { accepted, swarmUpdateStates };
  } finally {
    await execArgv(managerClient, ["rm", "-f", tmpPath]).catch(() => undefined);
  }
}

/**
 * Builds, one at a time, every compose service that declares a `build:` —
 * on the SAME capped builder as the nixpacks path, never in parallel: the
 * memory cap protects the machine, not each build individually. Rewrites
 * `services` IN PLACE, with `build:` replaced by the built tag.
 */
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
    // biome-ignore lint/performance/noAwaitInLoops: sequential builds on the SAME capped builder — parallelizing would exceed the memory cap it exists to enforce
    await buildImageFromDockerfile(opts.buildClient, {
      builderName: "noddle-builder",
      contextDir,
      dockerfilePath,
      imageTag,
      ...opts.stream,
    });

    serviceImages[key] = imageTag;
    // Rebuilds the object rather than `delete svc.build`: YAML
    // serialization of a key set to `undefined` isn't guaranteed to be
    // equivalent to its absence, and `docker stack deploy` would then see
    // an empty `build:` instead of nothing.
    const { build: _build, ...rest } = svc;
    opts.services[key] = { ...rest, image: imageTag };
  }

  return serviceImages;
}

// ─────────────────────────────────────────────────────────────────────────────
// Full deployment: clone, build, rollout
// ─────────────────────────────────────────────────────────────────────────────

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

/**
 * Clone, build, and roll out — everything that needs the SSH connection.
 * Hoisted out of `runStackDeploy` so the guard's closure does not push an
 * already dense function past the complexity ceiling.
 */
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
  await ensureCappedBuilder(buildClient, "noddle-builder", cap, stream);

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

  // ALWAYS pinned, unconditionally — see `placementFor` in deploy/placement.ts for the
  // full reasoning. A stack does NOT go through the registry: its images
  // stay local to the node that built them, so the constraint is never a
  // no-op once a second node has joined the cluster.
  //
  // The old code skipped this when the stack's server was the manager
  // (`sameConnection`), assuming it had no effect. Measured: the scheduler
  // placed the task on the worker, which answered "pull access denied" for
  // an image built locally — a deployment that "didn't converge in 180s"
  // with no visible cause.
  //
  // Read on the BUILD connection, never the manager's: it's a fact LOCAL to
  // that node.
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
    await db
      .update(stackDeployments)
      .set({
        finishedAt,
        status: settle("rollback_completed"),
        swarmUpdateStates,
      })
      .where(eq(stackDeployments.id, deployment.id));
    await db
      .update(stacks)
      .set(markCrashed(null, "stack deploy rolled back"))
      .where(eq(stacks.id, stack.id));
    return;
  }

  sink.write("✓ deployment accepted\n");
  await db
    .update(stackDeployments)
    .set({
      finishedAt,
      status: settle("completed"),
      swarmUpdateStates,
      watchUntil: watchUntilFor(finishedAt),
    })
    .where(eq(stackDeployments.id, deployment.id));

  await db
    .update(stacks)
    .set({ currentDeploymentId: deployment.id, ...markRunning(null) })
    .where(eq(stacks.id, stack.id));
  await clearSupersededStackWatch(db, stack.id, deployment.id);
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
    // The connection lives inside `withDeployClients`; a failure to connect
    // is caught the same way as any other failure below.
    await withDeployClients(ctx, stack.server, (clients) =>
      buildAndDeployStack(ctx, route, deployment, log, stream, clients)
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sink?.write(`✗ ${message}\n`);
    await db
      .update(stackDeployments)
      .set({ errorMessage: message, finishedAt: new Date(), status: "failed" })
      .where(eq(stackDeployments.id, deployment.id));
    await db
      .update(stacks)
      .set(markCrashed(null, message))
      .where(eq(stacks.id, stack.id));
    throw err;
  } finally {
    if (sink) {
      const { byteSize, storageUrl } = await sink.close();
      await db
        .insert(stackDeploymentLogs)
        .values({ byteSize, stackDeploymentId: deployment.id, storageUrl });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Rollback: replays a past version, no clone or build
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Replays a past `stack_deployments` row: the compose text AND the image
 * tags are already in the database, so no network access to the git
 * repository nor any new build — same principle as `redeployImage` for the
 * single-service path.
 */
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
  // Captured here: TypeScript's narrowing of `source.composeSource` above
  // does not survive into the closure passed to `withDeployClients` below.
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
          // Rebuilds the object rather than `delete svc.build` — same
          // reason as in `buildComposeServices`: YAML serialization of a
          // key set to `undefined` isn't guaranteed to be equivalent to
          // its absence.
          const { build: _build, ...rest } = svc;
          services[key] = { ...rest, image: tag };
        }
      }

      // Unconditional, same reason as in the initial deployment above.
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

      await ctx.db
        .update(stackDeployments)
        .set({
          finishedAt: new Date(),
          status: settle(accepted ? "completed" : "rollback_completed"),
          swarmUpdateStates,
        })
        .where(eq(stackDeployments.id, created.id));

      if (accepted) {
        await ctx.db
          .update(stacks)
          .set({ currentDeploymentId: created.id, ...markRunning(null) })
          .where(eq(stacks.id, stack.id));
        await clearSupersededStackWatch(ctx.db, stack.id, created.id);
      }

      return created.id;
    }
  );
}
