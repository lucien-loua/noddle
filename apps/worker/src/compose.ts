import { randomUUID } from "node:crypto";
import {
  buildImageFromDockerfile,
  computeBuildCap,
  ensureCappedBuilder,
  fetchSource,
} from "@noddle/build-engine";
import type { Database } from "@noddle/db";
import {
  stackDeploymentLogs,
  stackDeployments,
  stacks,
} from "@noddle/db/schema";
import { routeLabels } from "@noddle/proxy-config";
import {
  renderComposeHttpHealthcheck,
  renderComposeRestartPolicy,
  renderComposeRollbackConfig,
  renderComposeUpdateConfig,
} from "@noddle/shared/deploy-policy";
import {
  disconnect,
  dockerClient,
  execArgv,
  type SshClient,
  writeRemoteFile,
} from "@noddle/ssh-executor";
import { and, eq, isNotNull, ne } from "drizzle-orm";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { BUILD_ROOT, connectForDeploy, type DeployContext } from "#deploy";
import { createLogSink } from "#log-sink";
import {
  ensureOverlayNetwork,
  getSwarmNodeId,
  isDeployAccepted,
  readUpdateState,
  waitForRunningTask,
} from "#swarm";
import { watchUntilFor } from "#watch";

// ─────────────────────────────────────────────────────────────────────────────
// The compose file, typed just enough for what we read and rewrite
// ─────────────────────────────────────────────────────────────────────────────

interface ComposeBuildSpec {
  context?: string;
  dockerfile?: string;
}

interface ComposeService {
  build?: ComposeBuildSpec | string;
  deploy?: Record<string, unknown>;
  healthcheck?: unknown;
  image?: string;
  networks?: Record<string, unknown> | string[];
  [key: string]: unknown;
}

interface ComposeFile {
  networks?: Record<string, unknown>;
  services?: Record<string, ComposeService>;
  [key: string]: unknown;
}

/**
 * A compose key accepted as-is in a Swarm service name
 * (`${stackName}_${key}`) and in an image tag. A compose file comes from
 * the user: never a constant from the code, same caution as at
 * `fetchSource`'s entry point.
 */
const SAFE_COMPOSE_KEY = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/** Relative file path, with no escape from the cloned directory. */
const SAFE_RELATIVE_PATH = /^(?!\/)(?!.*\.\.)[\w./-]+$/;

function parseCompose(text: string, path: string): ComposeFile {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`invalid compose file (${path}): ${message}`, {
      cause: err,
    });
  }
  if (typeof doc !== "object" || doc === null || !("services" in doc)) {
    throw new Error(`compose file has no "services" section (${path})`);
  }
  return doc as ComposeFile;
}

/**
 * The service keys of a stored `stack_deployments.compose_source` — used
 * by `sweep.ts` to know WHICH Swarm services to inspect, without
 * duplicating the parsing here.
 */
export function listComposeServiceKeys(composeSource: string): string[] {
  const doc = parseCompose(composeSource, "(stored)");
  return Object.keys(doc.services ?? {});
}

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
// Injection: placement, health-gate, Traefik route
// ─────────────────────────────────────────────────────────────────────────────

interface InjectOptions {
  builtKeys: readonly string[];
  certResolver?: string;
  domain?: string | null;
  networkName: string;
  placementNodeId?: string;
  port?: number | null;
  publicService?: string | null;
  stackName: string;
}

/**
 * Same guarantee as `serviceSpec()` in Phase 1, expressed in YAML rather
 * than as a dockerode object: `docker stack deploy` translates
 * `deploy.update_config` / `deploy.rollback_config` into the same Swarm
 * API. Applied to EVERY service Noddle builds — not just the public one —
 * because a healthy, zero-downtime rollout is the guarantee Noddle sells,
 * not a privilege reserved for the exposed service alone.
 */
function injectDeployConfig(doc: ComposeFile, opts: InjectOptions): void {
  const services = doc.services ?? {};

  for (const key of opts.builtKeys) {
    const svc = services[key];
    if (!svc) {
      continue;
    }
    const deploy = { ...(svc.deploy ?? {}) } as Record<string, unknown>;

    if (opts.placementNodeId) {
      deploy.placement = {
        constraints: [`node.id==${opts.placementNodeId}`],
      };
    }
    deploy.update_config = renderComposeUpdateConfig();
    // `pause`, not `rollback`: a rollback that fails must not trigger
    // another one — same reason as the single-service path. Numbers live
    // in DeployPolicy (ADR-0012).
    deploy.rollback_config = renderComposeRollbackConfig();
    deploy.restart_policy = renderComposeRestartPolicy();
    svc.deploy = deploy;
  }

  if (!(opts.publicService && opts.port !== null && opts.port !== undefined)) {
    return;
  }
  const pub = services[opts.publicService];
  if (!pub) {
    return;
  }

  const swarmName = `${opts.stackName}_${opts.publicService}`;
  const deploy = { ...(pub.deploy ?? {}) } as Record<string, unknown>;
  deploy.labels = routeLabels({
    certResolver: opts.certResolver,
    domain: opts.domain ?? undefined,
    port: opts.port,
    serviceName: swarmName,
  });
  pub.deploy = deploy;

  // curl is present in the nixpacks base image and in most Node/Python
  // images; wget isn't and node isn't on a non-login shell's PATH — same
  // pitfall as `serviceSpec()`. We only inject it if the user doesn't
  // already have their own healthcheck: theirs takes priority.
  if (!pub.healthcheck) {
    pub.healthcheck = renderComposeHttpHealthcheck(opts.port);
  }

  // The public service must join the overlay network Traefik listens on,
  // IN ADDITION TO the stack's internal network — the stack's other
  // containers still need to keep reaching each other normally.
  doc.networks = {
    ...(doc.networks ?? {}),
    [opts.networkName]: { external: true },
  };
  if (Array.isArray(pub.networks)) {
    if (!pub.networks.includes(opts.networkName)) {
      pub.networks = [...pub.networks, opts.networkName];
    }
  } else if (pub.networks && typeof pub.networks === "object") {
    pub.networks = { ...pub.networks, [opts.networkName]: null };
  } else {
    pub.networks = [opts.networkName];
  }
}

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
  ctx: DeployContext,
  opts: {
    doc: ComposeFile;
    managerClient: SshClient;
    stackName: string;
    stream?: { onStderr: (s: string) => void; onStdout: (s: string) => void };
  }
): Promise<DeployStackResult> {
  const { managerClient, stackName, doc } = opts;
  const stream = opts.stream ?? {
    onStderr: () => undefined,
    onStdout: () => undefined,
  };
  const managerDocker = dockerClient(managerClient);
  await ensureOverlayNetwork(managerDocker, ctx.networkName);

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

export async function runStackDeploy(
  ctx: DeployContext,
  data: { stackDeploymentId: string }
): Promise<void> {
  const { db } = ctx;

  const deployment = await db.query.stackDeployments.findFirst({
    where: eq(stackDeployments.id, data.stackDeploymentId),
    with: { stack: { with: { server: true } } },
  });
  if (!deployment) {
    throw new Error(`stack deployment not found: ${data.stackDeploymentId}`);
  }

  const { stack } = deployment;
  const { server } = stack;
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

  const sink = await createLogSink({
    deploymentId: deployment.id,
    onChunk: (c) => ctx.onLog?.(deployment.id, c),
    root: ctx.logRoot,
  });
  const stream = { onStderr: sink.write, onStdout: sink.write };

  let buildClient: SshClient | undefined;
  let managerClient: SshClient | undefined;

  try {
    ({ buildClient, managerClient } = await connectForDeploy(ctx, server));

    const cap = computeBuildCap({
      totalMemoryMb: server.totalMemoryMb ?? 2048,
    });
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

    const buildDocker = dockerClient(buildClient);
    // ALWAYS pinned, unconditionally — see `placementFor` in deploy.ts for
    // the full reasoning. A stack does NOT go through the registry: its
    // images stay local to the node that built them, so the constraint is
    // never a no-op once a second node has joined the cluster.
    //
    // The old code skipped this when the stack's server was the manager
    // (`sameConnection`), assuming it had no effect. Measured: the
    // scheduler placed the task on the worker, which answered "pull access
    // denied" for an image built locally — a deployment that "didn't
    // converge in 180s" with no visible cause.
    //
    // Read on the BUILD connection, never the manager's: it's a fact LOCAL
    // to that node.
    const placementNodeId =
      server.swarmNodeId ?? (await getSwarmNodeId(buildDocker));

    injectDeployConfig(doc, {
      builtKeys: Object.keys(serviceImages),
      certResolver: ctx.certResolver,
      domain: stack.domain,
      networkName: ctx.networkName,
      placementNodeId,
      port: stack.port,
      publicService: stack.publicService,
      stackName: stack.swarmName,
    });

    sink.write("▸ Swarm rollout (docker stack deploy)\n");
    const { accepted, swarmUpdateStates } = await writeAndDeployStack(ctx, {
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
        .set({ finishedAt, status: "rolled_back", swarmUpdateStates })
        .where(eq(stackDeployments.id, deployment.id));
      await db
        .update(stacks)
        .set({ status: "crashed" })
        .where(eq(stacks.id, stack.id));
      return;
    }

    sink.write("✓ deployment accepted\n");
    await db
      .update(stackDeployments)
      .set({
        finishedAt,
        status: "succeeded",
        swarmUpdateStates,
        watchUntil: watchUntilFor(finishedAt),
      })
      .where(eq(stackDeployments.id, deployment.id));

    await db
      .update(stacks)
      .set({ currentDeploymentId: deployment.id, status: "running" })
      .where(eq(stacks.id, stack.id));
    await clearSupersededStackWatch(db, stack.id, deployment.id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sink.write(`✗ ${message}\n`);
    await db
      .update(stackDeployments)
      .set({ errorMessage: message, finishedAt: new Date(), status: "failed" })
      .where(eq(stackDeployments.id, deployment.id));
    throw err;
  } finally {
    if (managerClient && managerClient !== buildClient) {
      disconnect(managerClient);
    }
    if (buildClient) {
      disconnect(buildClient);
    }
    const { byteSize, storageUrl } = await sink.close();
    await db
      .insert(stackDeploymentLogs)
      .values({ byteSize, stackDeploymentId: deployment.id, storageUrl });
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

  const [created] = await ctx.db
    .insert(stackDeployments)
    .values({
      commitSha: source.commitSha,
      composeSource: source.composeSource,
      serviceImages: source.serviceImages,
      stackId: stack.id,
      status: "deploying",
      trigger: opts.trigger,
    })
    .returning();
  if (!created) {
    throw new Error("could not create stack deployment");
  }

  const { buildClient, managerClient, sameConnection } = await connectForDeploy(
    ctx,
    stack.server
  );

  try {
    const doc = parseCompose(source.composeSource, stack.composeFilePath);
    const services = doc.services ?? {};
    const serviceImages = (source.serviceImages ?? {}) as Record<
      string,
      string
    >;
    for (const [key, tag] of Object.entries(serviceImages)) {
      const svc = services[key];
      if (svc) {
        // Rebuilds the object rather than `delete svc.build` — same reason
        // as in `buildComposeServices`: YAML serialization of a key set to
        // `undefined` isn't guaranteed to be equivalent to its absence.
        const { build: _build, ...rest } = svc;
        services[key] = { ...rest, image: tag };
      }
    }

    const buildDocker = dockerClient(buildClient);
    // Unconditional, same reason as in the initial deployment above.
    const placementNodeId =
      stack.server.swarmNodeId ?? (await getSwarmNodeId(buildDocker));

    injectDeployConfig(doc, {
      builtKeys: Object.keys(serviceImages),
      certResolver: ctx.certResolver,
      domain: stack.domain,
      networkName: ctx.networkName,
      placementNodeId,
      port: stack.port,
      publicService: stack.publicService,
      stackName: stack.swarmName,
    });

    const { accepted, swarmUpdateStates } = await writeAndDeployStack(ctx, {
      doc,
      managerClient,
      stackName: stack.swarmName,
    });

    await ctx.db
      .update(stackDeployments)
      .set({
        finishedAt: new Date(),
        status: accepted ? "succeeded" : "rolled_back",
        swarmUpdateStates,
      })
      .where(eq(stackDeployments.id, created.id));

    if (accepted) {
      await ctx.db
        .update(stacks)
        .set({ currentDeploymentId: created.id, status: "running" })
        .where(eq(stacks.id, stack.id));
      await clearSupersededStackWatch(ctx.db, stack.id, created.id);
    }

    return created.id;
  } finally {
    if (!sameConnection) {
      disconnect(managerClient);
    }
    disconnect(buildClient);
  }
}
