import { setTimeout as sleep } from "node:timers/promises";

import type { TraefikLabels } from "@noddle/deploy-engine";
import {
  MONITOR_SECONDS,
  renderDockerodeHttpHealthcheck,
} from "@noddle/shared/deploy-policy";
import { dockerodeWorkloadPolicy } from "@noddle/shared/workload";
import type { DockerApi } from "@noddle/ssh-executor";

export interface DeploySpec {
  env: Record<string, string>;
  image: string;
  labels: TraefikLabels;
  networkName: string;
  placementNodeId?: string;
  port: number;
  registryAuth?: RegistryAuth;
  serviceName: string;
}

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
  const policy = dockerodeWorkloadPolicy();
  return {
    Labels: s.labels,
    Mode: { Replicated: { Replicas: 1 } },
    Name: s.serviceName,
    Networks: [{ Target: s.networkName }],
    RollbackConfig: policy.RollbackConfig,
    TaskTemplate: {
      ...(s.placementNodeId
        ? { Placement: { Constraints: [`node.id==${s.placementNodeId}`] } }
        : {}),
      ContainerSpec: {
        Env: Object.entries(s.env).map(([k, v]) => `${k}=${v}`),
        Healthcheck: renderDockerodeHttpHealthcheck(s.port),
        Image: s.image,
      },
      Networks: [{ Target: s.networkName }],
      RestartPolicy: policy.RestartPolicy,
    },
    UpdateConfig: policy.UpdateConfig,
  };
}

export async function waitForRunningTask(
  docker: DockerApi,
  serviceName: string,
  timeoutMs = 180_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";

  while (Date.now() < deadline) {
    const tasks = (await docker.listTasks({
      filters: JSON.stringify({ service: [serviceName] }),
    })) as unknown as {
      DesiredState?: string;
      Status?: { Err?: string; State?: string };
    }[];

    if (tasks.some((t) => t.Status?.State === "running")) {
      return;
    }
    const dead = tasks.filter(
      (t) => t.Status?.State === "failed" || t.Status?.State === "rejected"
    );
    if (dead.length > 0) {
      lastError = dead.at(-1)?.Status?.Err ?? "";
    }
    await sleep(2000);
  }

  throw new Error(
    `service ${serviceName} did not converge within ${timeoutMs / 1000}s${lastError ? `: ${lastError}` : ""}`
  );
}

export interface DeployOutcome {
  accepted: boolean;
  created: boolean;
  runningImage: string | null;
  updateMessage: string | null;
  updateState: SwarmUpdateState | null;
}

export type SwarmUpdateReading = Omit<DeployOutcome, "accepted" | "created">;

async function findService(docker: DockerApi, name: string) {
  const list = await docker.listServices({
    filters: JSON.stringify({ name: [name] }),
  });
  return list.find((s) => s.Spec?.Name === name) ?? null;
}

export async function deployService(
  docker: DockerApi,
  spec: DeploySpec
): Promise<DeployOutcome> {
  const existing = await findService(docker, spec.serviceName);

  const auth = spec.registryAuth;

  if (!existing) {
    if (auth) {
      await docker.createService(auth, serviceSpec(spec));
    } else {
      await docker.createService(serviceSpec(spec));
    }
    return awaitSwarmVerdict(docker, spec.serviceName, { created: true });
  }

  const service = docker.getService(existing.ID);
  await service.update({
    ...serviceSpec(spec),
    ...(auth ? { authconfig: auth } : {}),
    version: existing.Version?.Index,
  });

  return awaitSwarmVerdict(docker, spec.serviceName, { created: false });
}

export async function readRunningNodeId(
  docker: DockerApi,
  serviceName: string
): Promise<string | null> {
  const tasks = (await docker.listTasks({
    filters: JSON.stringify({ service: [serviceName] }),
  })) as unknown as {
    NodeID?: string;
    Status?: { State?: string };
  }[];
  const running = tasks.find((t) => t.Status?.State === "running");
  return running?.NodeID ?? null;
}

export async function readUpdateState(
  docker: DockerApi,
  serviceName: string,
  opts: { timeoutMs?: number; pollMs?: number } = {}
): Promise<SwarmUpdateReading> {
  const timeout = opts.timeoutMs ?? (MONITOR_SECONDS + 60) * 1000;
  const poll = opts.pollMs ?? 2000;
  const deadline = Date.now() + timeout;

  let last: SwarmUpdateReading = {
    runningImage: null,
    updateMessage: null,
    updateState: null,
  };

  while (Date.now() < deadline) {
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

    if (!last.updateState) {
      return last;
    }
    if (
      last.updateState !== "updating" &&
      last.updateState !== "rollback_started"
    ) {
      return last;
    }

    await sleep(poll);
  }

  return last;
}

export function isDeployAccepted(state: SwarmUpdateState | null): boolean {
  return state === null || state === "completed";
}

export async function awaitSwarmVerdict(
  docker: DockerApi,
  serviceName: string,
  opts: { created: boolean }
): Promise<DeployOutcome> {
  if (opts.created) {
    await waitForRunningTask(docker, serviceName);
  }
  const state = await readUpdateState(docker, serviceName);
  return {
    accepted: isDeployAccepted(state.updateState),
    created: opts.created,
    ...state,
  };
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

const SCALE_DOWN_TIMEOUT_MS = 120_000;

export async function scaleServiceAndWait(
  docker: DockerApi,
  serviceName: string,
  replicas: number,
  timeoutMs = SCALE_DOWN_TIMEOUT_MS
): Promise<void> {
  const scaled = await scaleService(docker, serviceName, replicas);
  if (!scaled) {
    throw new Error(`Swarm service not found: ${serviceName}`);
  }

  if (replicas === 0) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const tasks = (await docker.listTasks({
        filters: JSON.stringify({ service: [serviceName] }),
      })) as unknown as { Status?: { State?: string } }[];
      const alive = tasks.filter((t) => {
        const state = t.Status?.State;
        return (
          state !== "shutdown" && state !== "failed" && state !== "complete"
        );
      });
      if (alive.length === 0) {
        return;
      }
      await sleep(1000);
    }
    throw new Error(`service ${serviceName} did not scale down to 0 replicas`);
  }

  await waitForRunningTask(docker, serviceName);
}

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

export async function getSwarmNodeId(docker: DockerApi): Promise<string> {
  const info = (await docker.info()) as { Swarm?: { NodeID?: string } };
  const nodeId = info.Swarm?.NodeID;
  if (!nodeId) {
    throw new Error("this node has no Swarm ID. Did it join the cluster?");
  }
  return nodeId;
}
