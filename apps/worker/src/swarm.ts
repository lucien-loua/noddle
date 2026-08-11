import type { TraefikLabels } from "@noddle/proxy-config";
import {
  MONITOR_SECONDS,
  renderDockerodeHttpHealthcheck,
  renderDockerodeRestartPolicy,
  renderDockerodeRollbackConfig,
  renderDockerodeUpdateConfig,
} from "@noddle/shared/deploy-policy";
import { swarmServiceName as sharedSwarmServiceName } from "@noddle/shared/swarm-names";
import type { DockerApi } from "@noddle/ssh-executor";

/**
 * Window during which Swarm watches a task after starting it.
 * Re-exported from DeployPolicy so existing imports keep working.
 */
export const UPDATE_MONITOR_SECONDS = MONITOR_SECONDS;

/** Re-export: naming lives in shared so web and worker share one formula. */
export const swarmServiceName = sharedSwarmServiceName;

export interface DeploySpec {
  /** Already decrypted. Never log this object. */
  env: Record<string, string>;
  image: string;
  labels: TraefikLabels;
  networkName: string;
  /**
   * Swarm ID of the node that built the image, not to be confused with a
   * database ID: it's `docker info` on THAT node that gives it, a value
   * local to the Swarm cluster and not an identifier Noddle invents.
   *
   * `undefined` when the image is PORTABLE — i.e. it lives in the registry:
   * Swarm can then place it wherever it wants, which is precisely what we
   * want. Also `undefined` on a single-node cluster, where the constraint
   * would be a no-op.
   *
   * Set for any image LOCAL to a node, including a rollback to an image
   * from before the registry: it exists nowhere else, and Swarm would
   * blindly schedule a task that would never find it. The decision is
   * therefore made image by image, never globally.
   */
  placementNodeId?: string;
  port: number;
  /**
   * Registry credentials, passed to Swarm and not used here.
   *
   * The manager encrypts them into the service spec and distributes them to
   * the agents: THEY are the ones pulling, on nodes where Noddle opens no
   * session. It's the API equivalent of `--with-registry-auth`, and it's
   * what avoids a persistent `docker login` on every machine.
   */
  registryAuth?: RegistryAuth;
  serviceName: string;
}

/** The shape expected by the Engine API's `X-Registry-Auth` header. */
export interface RegistryAuth {
  password: string;
  serveraddress: string;
  username: string;
}

export type SwarmUpdateState =
  | "completed"
  | "paused"
  | "rollback_completed"
  | "rollback_paused"
  | "rollback_started"
  | "updating"
  | (string & {});

function serviceSpec(s: DeploySpec) {
  return {
    Labels: s.labels,
    Mode: { Replicated: { Replicas: 1 } },
    Name: s.serviceName,
    Networks: [{ Target: s.networkName }],
    RollbackConfig: {
      // `pause` and not `rollback`: a rollback that fails must not trigger a
      // rollback of the rollback. We stop and let Noddle decide from its
      // history. Numbers live in DeployPolicy (ADR-0012).
      ...renderDockerodeRollbackConfig(),
    },
    TaskTemplate: {
      // Absent (not `{ Constraints: [] }`) on a single node: an empty list
      // is already valid for the API, but the distinction stays more honest
      // about what's actually being requested.
      ...(s.placementNodeId
        ? { Placement: { Constraints: [`node.id==${s.placementNodeId}`] } }
        : {}),
      ContainerSpec: {
        Env: Object.entries(s.env).map(([k, v]) => `${k}=${v}`),
        // curl is present in nixpacks's base image, wget isn't, and node
        // isn't in a non-login shell's PATH — and HEALTHCHECK runs in a
        // non-login `sh -c`. Measured in Phase 0; all three look identical
        // until you actually run them.
        Healthcheck: renderDockerodeHttpHealthcheck(s.port),
        Image: s.image,
      },
      Networks: [{ Target: s.networkName }],
      RestartPolicy: renderDockerodeRestartPolicy(),
    },
    UpdateConfig: {
      // The health gate: if the task never becomes healthy, Swarm rolls
      // back on its own and the old version never stopped serving.
      ...renderDockerodeUpdateConfig(),
    },
  };
}

/**
 * Wait until a service task is actually `running`.
 *
 * With a HEALTHCHECK, Swarm keeps the task in `starting` until it is
 * healthy: reaching `running` is therefore a health gate on create, exactly
 * as UpdateStatus is for an update.
 *
 * Exported for `compose.ts`: a stack deploy calls `docker stack deploy`,
 * which returns before convergence exactly like `docker service update` —
 * each resulting service needs THIS SAME poll, one by one.
 */
export async function waitForRunningTask(
  docker: DockerApi,
  serviceName: string,
  timeoutMs = 180_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";

  while (Date.now() < deadline) {
    // biome-ignore lint/performance/noAwaitInLoops: deliberate polling loop
    const tasks = (await docker.listTasks({
      filters: JSON.stringify({ service: [serviceName] }),
    })) as unknown as Array<{
      DesiredState?: string;
      Status?: { Err?: string; State?: string };
    }>;

    if (tasks.some((t) => t.Status?.State === "running")) {
      return;
    }
    const dead = tasks.filter(
      (t) => t.Status?.State === "failed" || t.Status?.State === "rejected"
    );
    if (dead.length > 0) {
      lastError = dead.at(-1)?.Status?.Err ?? "";
    }
    // The restart policy retries: do not exit on the first failure, let the
    // deadline run. A service that never converges will time out.
    await new Promise((r) => setTimeout(r, 2000));
  }

  throw new Error(
    `service ${serviceName} did not converge within ${timeoutMs / 1000}s${lastError ? ` — ${lastError}` : ""}`
  );
}

export interface DeployOutcome {
  created: boolean;
  runningImage: string | null;
  updateMessage: string | null;
  /** Read from the service, never inferred from an exit code. */
  updateState: SwarmUpdateState | null;
}

async function findService(docker: DockerApi, name: string) {
  const list = await docker.listServices({
    filters: JSON.stringify({ name: [name] }),
  });
  // Docker's `name` filter is a prefix: `api` would also match `api-staging`.
  return list.find((s) => s.Spec?.Name === name) ?? null;
}

export async function deployService(
  docker: DockerApi,
  spec: DeploySpec
): Promise<DeployOutcome> {
  const existing = await findService(docker, spec.serviceName);

  // Auth goes as the FIRST POSITIONAL ARGUMENT, never in the options.
  // Measured against a real VM, and it's a dockerode trap:
  //
  //   Docker.prototype.createService = function (auth, opts, callback) {
  //     if (!callback && typeof opts === 'function') { … auth = opts.authconfig }
  //     else if (!opts && !callback) { opts = auth }   ← auth remains the SPEC
  //
  // Called with a single argument — the promise form — `auth` stays the
  // entire spec, which docker-modem base64-encodes into `X-Registry-Auth`.
  // The daemon finds no credentials there, and the pulling agent responds
  // "no basic auth credentials": a deployment that never converges, whose
  // message doesn't name the cause.
  //
  // `Service.prototype.update`, by contrast, does extract `opts.authconfig`
  // in that case. The asymmetry means only a service CREATE triggers the
  // bug — so the first deployment of a service, never the following ones.
  // Passing both arguments explicitly removes the question.
  const auth = spec.registryAuth;

  if (!existing) {
    if (auth) {
      await docker.createService(auth, serviceSpec(spec));
    } else {
      await docker.createService(serviceSpec(spec));
    }
    // A create has NO UpdateStatus — there was no update. readUpdateState
    // would therefore return immediately and we would announce a successful
    // deployment while the container is still starting: the service goes
    // running, but Traefik answers 404 until the task converges. On create,
    // convergence is read from the TASKS.
    await waitForRunningTask(docker, spec.serviceName);
    const state = await readUpdateState(docker, spec.serviceName);
    return { created: true, ...state };
  }

  const service = docker.getService(existing.ID);
  // Same two-argument form as on create, even though `update` can extract
  // `opts.authconfig`: depending on that difference is how you reproduce
  // the bug on the next refactor.
  // `update` DOES extract `opts.authconfig` when called with a single
  // argument (that's dockerode's `typeof opts === 'undefined'` branch) —
  // unlike `createService`, which then leaves `auth` as the spec. Hence the
  // two different forms above and here: each is the one that works for ITS
  // method, rather than a single form that would half-work.
  await service.update({
    ...serviceSpec(spec),
    ...(auth ? { authconfig: auth } : {}),
    version: existing.Version?.Index,
  });

  const state = await readUpdateState(docker, spec.serviceName);
  return { created: false, ...state };
}

/**
 * The node on which a service task is ACTUALLY running.
 *
 * While every image was local, the question never arose: the placement
 * constraint gave the answer in advance. With a registry, Swarm's scheduler
 * chooses, and a dashboard that kept showing the BUILD server as the
 * execution site would assert something false.
 *
 * Returns `null` rather than a fallback when no task is running: a hole
 * stays a hole. "We don't know where it runs" and "it runs on the build
 * server" are two different claims, and the second would be invented.
 */
export async function readRunningNodeId(
  docker: DockerApi,
  serviceName: string
): Promise<string | null> {
  const tasks = (await docker.listTasks({
    filters: JSON.stringify({ service: [serviceName] }),
  })) as unknown as Array<{
    NodeID?: string;
    Status?: { State?: string };
  }>;
  const running = tasks.find((t) => t.Status?.State === "running");
  return running?.NodeID ?? null;
}

/**
 * Wait until Swarm has decided, then report what it decided.
 *
 * `updating` is not a verdict: the monitor window must elapse, otherwise
 * we conclude "succeeded" on a deployment that will be cancelled ten
 * seconds later.
 */
export async function readUpdateState(
  docker: DockerApi,
  serviceName: string,
  opts: { timeoutMs?: number; pollMs?: number } = {}
): Promise<Omit<DeployOutcome, "created">> {
  const timeout = opts.timeoutMs ?? (UPDATE_MONITOR_SECONDS + 60) * 1000;
  const poll = opts.pollMs ?? 2000;
  const deadline = Date.now() + timeout;

  let last: Omit<DeployOutcome, "created"> = {
    runningImage: null,
    updateMessage: null,
    updateState: null,
  };

  while (Date.now() < deadline) {
    // Polling: each turn depends on the previous one, sequentiality IS the
    // intended behaviour. Nothing to parallelise here — unlike the case
    // where independent operations get serialised by accident.
    // biome-ignore lint/performance/noAwaitInLoops: deliberate polling loop
    const found = await findService(docker, serviceName);
    if (!found) {
      return last;
    }

    const raw = found as unknown as {
      UpdateStatus?: { State?: string; Message?: string };
      Spec?: { TaskTemplate?: { ContainerSpec?: { Image?: string } } };
    };

    last = {
      runningImage: raw.Spec?.TaskTemplate?.ContainerSpec?.Image ?? null,
      updateMessage: raw.UpdateStatus?.Message ?? null,
      updateState: raw.UpdateStatus?.State ?? null,
    };

    // A freshly created service has no UpdateStatus: there was no update.
    // That's a terminal state, not a wait.
    if (!last.updateState) {
      return last;
    }
    if (
      last.updateState !== "updating" &&
      last.updateState !== "rollback_started"
    ) {
      return last;
    }

    await new Promise((r) => setTimeout(r, poll));
  }

  return last;
}

/**
 * An `updateState` that is neither `completed` nor absent means Swarm
 * refused the switch. The deployment failed even if no command returned
 * an error.
 */
export function isDeployAccepted(state: SwarmUpdateState | null): boolean {
  return state === null || state === "completed";
}

export async function removeService(
  docker: DockerApi,
  serviceName: string
): Promise<void> {
  const found = await findService(docker, serviceName);
  if (found) {
    await docker.getService(found.ID).remove();
  }
}

/**
 * Stop, start, restart — by REPLICA COUNT, never by removing the service.
 *
 * Stopping by removing the Swarm service would lose its Traefik labels, its
 * network and its placement constraint: "start again" would become a full
 * redeploy, with the risk of landing elsewhere. At zero replicas, the
 * specification stays intact and restart is instantaneous.
 *
 * Known consequence: Traefik keeps the router of a stopped service, so its
 * domain answers **502** rather than 404. That's the right trade-off — a
 * 404 would say "this domain doesn't exist" when it exists and is off —
 * but it had to be chosen rather than suffered.
 *
 * We read `Spec` then rewrite it ENTIRELY with `version`: the Swarm API
 * has no partial update. Omitting a field resets it to its default — that's
 * how you wipe labels without noticing.
 */
export async function scaleService(
  docker: DockerApi,
  serviceName: string,
  replicas: number
): Promise<boolean> {
  const found = await findService(docker, serviceName);
  if (!found?.Spec) {
    return false;
  }
  const service = docker.getService(found.ID);
  await service.update({
    ...found.Spec,
    Mode: { Replicated: { Replicas: replicas } },
    version: found.Version?.Index,
  });
  return true;
}

/**
 * Restarts the tasks without changing the specification.
 *
 * `ForceUpdate` is a counter Swarm compares from one version to the next:
 * incrementing it is the only documented way to say "recreate the
 * containers" when the spec is otherwise identical. Without it, Swarm sees
 * that nothing moved and does NOTHING — a "restart" that doesn't restart.
 */
export async function restartService(
  docker: DockerApi,
  serviceName: string
): Promise<boolean> {
  const found = await findService(docker, serviceName);
  if (!found?.Spec) {
    return false;
  }
  const spec = found.Spec as {
    TaskTemplate?: { ForceUpdate?: number };
  } & Record<string, unknown>;
  const service = docker.getService(found.ID);
  await service.update({
    ...spec,
    TaskTemplate: {
      ...spec.TaskTemplate,
      ForceUpdate: (spec.TaskTemplate?.ForceUpdate ?? 0) + 1,
    },
    version: found.Version?.Index,
  });
  return true;
}

/** The overlay network that Traefik and the services share. */
export async function ensureOverlayNetwork(
  docker: DockerApi,
  name: string
): Promise<void> {
  const nets = await docker.listNetworks({
    filters: JSON.stringify({ name: [name] }),
  });
  if (nets.some((n) => n.Name === name)) {
    return;
  }
  await docker.createNetwork({
    Attachable: true,
    Driver: "overlay",
    Name: name,
  });
}

/**
 * The Swarm ID of the node BEHIND this connection — the one that just built
 * the image, never the one that receives the `docker service create/update`
 * command when the two differ.
 *
 * `docker info` is a local read: a worker node answers correctly about
 * itself, unlike `docker service` or `docker node`, which are reserved for
 * the manager because they read the cluster's replicated state.
 */
export async function getSwarmNodeId(docker: DockerApi): Promise<string> {
  const info = (await docker.info()) as { Swarm?: { NodeID?: string } };
  const nodeId = info.Swarm?.NodeID;
  if (!nodeId) {
    throw new Error("this node has no Swarm ID — did it join the cluster?");
  }
  return nodeId;
}
