import type { EngineParams, EngineSpec } from "@noddle/shared/database-spec";
import { SECRET_MODE_OWNER_READ_ONLY } from "@noddle/shared/database-spec";
import type { DockerApi } from "@noddle/ssh-executor";

import { SECOND_NS } from "./deploy-policy.ts";
import {
  awaitSwarmVerdict,
  ensureOverlayNetwork,
  findService,
  getSwarmNodeId,
} from "./swarm.ts";
import type { DeployOutcome } from "./swarm.ts";
import { dockerodeWorkloadPolicy } from "./workload.ts";
import type {
  DockerodeRestartPolicyOverride,
  DockerodeRollbackConfigOverride,
  DockerodeUpdateConfigOverride,
} from "./workload.ts";

export interface DatabaseSwarmOverrides {
  endpointSpec?: { Mode?: "dnsrr" | "vip" } | null;
  healthCheck?: {
    Interval?: number | null;
    Retries?: number | null;
    StartPeriod?: number | null;
    Test?: string[] | null;
    Timeout?: number | null;
  } | null;
  labels?: Record<string, string> | null;
  mode?: {
    Global?: Record<string, never>;
    Replicated?: { Replicas?: number };
  } | null;
  networks?: { Aliases?: string[]; Target: string }[] | null;
  placement?: {
    Constraints?: string[];
    MaxReplicas?: number;
    Preferences?: { Spread: { SpreadDescriptor: string } }[];
  } | null;
  restartPolicy?: DockerodeRestartPolicyOverride | null;
  rollbackConfig?: DockerodeRollbackConfigOverride | null;
  stopGracePeriod?: number | null;
  updateConfig?: DockerodeUpdateConfigOverride | null;
}

function mergeEnv(engineEnv: string[], userEnv: string[]): string[] {
  const reserved = new Set(
    engineEnv.map((entry) => entry.slice(0, entry.indexOf("=")))
  );
  return [
    ...engineEnv,
    ...userEnv.filter((entry) => {
      const key = entry.slice(0, entry.indexOf("="));
      return !reserved.has(key);
    }),
  ];
}

async function ensureVolume(docker: DockerApi, name: string): Promise<void> {
  const list = (await docker.listVolumes()) as unknown as {
    Volumes?: { Name?: string }[];
  };
  if (list.Volumes?.some((v) => v.Name === name)) {
    return;
  }
  await docker.createVolume({ Name: name });
}

async function ensureSecret(
  managerDocker: DockerApi,
  name: string,
  plaintext: string
): Promise<string> {
  const list = await managerDocker.listSecrets({
    filters: JSON.stringify({ name: [name] }),
  });
  const existing = list.find((s) => s.Spec?.Name === name);
  if (existing?.ID) {
    return existing.ID;
  }
  const created = (await managerDocker.createSecret({
    Data: Buffer.from(plaintext, "utf-8").toString("base64"),
    Name: name,
  })) as unknown as { id: string };
  return created.id;
}

export async function removeSecretIfExists(
  managerDocker: DockerApi,
  name: string
): Promise<void> {
  try {
    const list = (await managerDocker.listSecrets({
      filters: JSON.stringify({ name: [name] }),
    })) as unknown as { ID?: string; Spec?: { Name?: string } }[];
    const existing = list.find((s) => s.Spec?.Name === name);
    if (existing?.ID) {
      await managerDocker.getSecret(existing.ID).remove();
    }
  } catch {
    // best-effort: a secret already gone is not a failure
  }
}

function isNullish(value: unknown): value is null | undefined {
  return value === null || value === undefined;
}

function swarmResourceSpec(resources: {
  cpuLimitNanos: number | null;
  cpuReservationNanos: number | null;
  memoryLimitBytes: number | null;
  memoryReservationBytes: number | null;
}) {
  const limits: { MemoryBytes?: number; NanoCPUs?: number } = {};
  if (!isNullish(resources.memoryLimitBytes)) {
    limits.MemoryBytes = resources.memoryLimitBytes;
  }
  if (!isNullish(resources.cpuLimitNanos)) {
    limits.NanoCPUs = resources.cpuLimitNanos;
  }

  const reservations: { MemoryBytes?: number; NanoCPUs?: number } = {};
  if (!isNullish(resources.memoryReservationBytes)) {
    reservations.MemoryBytes = resources.memoryReservationBytes;
  }
  if (!isNullish(resources.cpuReservationNanos)) {
    reservations.NanoCPUs = resources.cpuReservationNanos;
  }

  const resourceSpec: {
    Limits?: typeof limits;
    Reservations?: typeof reservations;
  } = {};
  if (Object.keys(limits).length > 0) {
    resourceSpec.Limits = limits;
  }
  if (Object.keys(reservations).length > 0) {
    resourceSpec.Reservations = reservations;
  }
  return resourceSpec;
}

function resolveHealthcheck(
  defaultHealthcheck:
    | {
        Interval: number;
        Retries: number;
        StartPeriod: number;
        Test: string[];
        Timeout: number;
      }
    | { Test: string[] },
  healthOverride: DatabaseSwarmOverrides["healthCheck"]
) {
  if (isNullish(healthOverride)) {
    return defaultHealthcheck;
  }
  const out: {
    Interval?: number;
    Retries?: number;
    StartPeriod?: number;
    Test?: string[];
    Timeout?: number;
  } = {};
  if (!isNullish(healthOverride.Interval)) {
    out.Interval = healthOverride.Interval;
  }
  if (!isNullish(healthOverride.Retries)) {
    out.Retries = healthOverride.Retries;
  }
  if (!isNullish(healthOverride.StartPeriod)) {
    out.StartPeriod = healthOverride.StartPeriod;
  }
  if (!isNullish(healthOverride.Test)) {
    out.Test = healthOverride.Test;
  }
  if (!isNullish(healthOverride.Timeout)) {
    out.Timeout = healthOverride.Timeout;
  }
  return out;
}

function buildEndpointSpec(opts: {
  endpointMode: "dnsrr" | "vip" | undefined;
  externalPort: number | null;
  targetPort: number;
}) {
  const endpointSpec: {
    Mode?: "dnsrr" | "vip";
    Ports?: {
      Protocol: "tcp";
      PublishedPort: number;
      PublishMode: "ingress";
      TargetPort: number;
    }[];
  } = {};
  if (opts.endpointMode) {
    endpointSpec.Mode = opts.endpointMode;
  }
  if (opts.externalPort) {
    endpointSpec.Ports = [
      {
        Protocol: "tcp",
        PublishMode: "ingress",
        PublishedPort: opts.externalPort,
        TargetPort: opts.targetPort,
      },
    ];
  }
  return endpointSpec;
}

function resolveSwarmOverrides(opts: {
  networkName: string;
  placementNodeId?: string;
  replicas: number;
  swarmSettings: DatabaseSwarmOverrides | null;
}) {
  const { networkName, placementNodeId, replicas, swarmSettings } = opts;
  return {
    labels: { "traefik.enable": "false", ...swarmSettings?.labels },
    mode:
      swarmSettings?.mode ?? ({ Replicated: { Replicas: replicas } } as const),
    networks:
      swarmSettings?.networks && swarmSettings.networks.length > 0
        ? swarmSettings.networks
        : [{ Target: networkName }],
    placement:
      swarmSettings?.placement ??
      (placementNodeId
        ? { Constraints: [`node.id==${placementNodeId}`] }
        : undefined),
  };
}

function databaseServiceSpec(opts: {
  databaseName: string | null;
  externalPort: number | null;
  extraEnv: string[];
  extraMounts: {
    source: string;
    target: string;
    type: "bind" | "volume";
  }[];
  image: string;
  name: string;
  networkName: string;
  placementNodeId?: string;
  replicas: number;
  resources: {
    cpuLimitNanos: number | null;
    cpuReservationNanos: number | null;
    memoryLimitBytes: number | null;
    memoryReservationBytes: number | null;
  };
  rootUser: string | null;
  secretId: string;
  spec: EngineSpec;
  swarmSettings: DatabaseSwarmOverrides | null;
  volumePath: string;
}) {
  const {
    databaseName,
    externalPort,
    extraEnv,
    extraMounts,
    image,
    name,
    networkName,
    placementNodeId,
    replicas,
    resources,
    rootUser,
    secretId,
    spec,
    swarmSettings,
    volumePath,
  } = opts;

  const resourceSpec = swarmResourceSpec(resources);
  const secretPath = `/run/secrets/${spec.secretFile}`;
  const params: EngineParams = { databaseName, rootUser, secretPath };

  const defaultHealthcheck = spec.healthcheck
    ? {
        Interval: 3 * SECOND_NS,
        Retries: 5,
        StartPeriod: 5 * SECOND_NS,
        Test: spec.healthcheck(params),
        Timeout: 3 * SECOND_NS,
      }
    : { Test: ["NONE"] };

  const healthcheck = resolveHealthcheck(
    defaultHealthcheck,
    swarmSettings?.healthCheck
  );

  const { labels, mode, networks, placement } = resolveSwarmOverrides({
    networkName,
    placementNodeId,
    replicas,
    swarmSettings,
  });

  const mounts = [
    { Source: name, Target: volumePath, Type: "volume" as const },
    ...extraMounts.map((m) => ({
      Source: m.source,
      Target: m.target,
      Type: m.type,
    })),
  ];

  const endpointSpec = buildEndpointSpec({
    endpointMode: swarmSettings?.endpointSpec?.Mode,
    externalPort,
    targetPort: spec.port,
  });

  const workloadPolicy = dockerodeWorkloadPolicy({
    restartPolicy: swarmSettings?.restartPolicy,
    rollbackConfig: swarmSettings?.rollbackConfig,
    updateConfig: swarmSettings?.updateConfig,
  });

  return {
    ...(Object.keys(endpointSpec).length > 0
      ? { EndpointSpec: endpointSpec }
      : {}),
    Labels: labels,
    Mode: mode,
    Name: name,
    Networks: networks,
    RollbackConfig: workloadPolicy.RollbackConfig,
    TaskTemplate: {
      ...(placement ? { Placement: placement } : {}),
      ContainerSpec: {
        ...(spec.command ? { Command: spec.command(params) } : {}),
        Env: mergeEnv(spec.env(params), extraEnv),
        Healthcheck: healthcheck,
        Image: image,
        Mounts: mounts,
        Secrets: [
          {
            File: {
              GID: "0",
              Mode: spec.secretMode ?? SECRET_MODE_OWNER_READ_ONLY,
              Name: spec.secretFile,
              UID: "0",
            },
            SecretID: secretId,
            SecretName: `${name}-password`,
          },
        ],
        ...(isNullish(swarmSettings?.stopGracePeriod)
          ? {}
          : { StopGracePeriod: swarmSettings.stopGracePeriod }),
      },
      Networks: networks,
      ...(Object.keys(resourceSpec).length > 0
        ? { Resources: resourceSpec }
        : {}),
      RestartPolicy: workloadPolicy.RestartPolicy,
    },
    UpdateConfig: workloadPolicy.UpdateConfig,
  };
}

export interface ProvisionDatabaseSpec {
  databaseName: string | null;
  engine: EngineSpec;
  engineLabel: string;
  env: string[];
  externalPort: number | null;
  extraMounts: {
    source: string;
    target: string;
    type: "bind" | "volume";
  }[];
  image: string;
  name: string;
  networkName: string;
  password: string;
  replicas: number;
  resources: {
    cpuLimitNanos: number | null;
    cpuReservationNanos: number | null;
    memoryLimitBytes: number | null;
    memoryReservationBytes: number | null;
  };
  rootUser: string | null;
  swarmNodeId: string | null;
  swarmSettings: DatabaseSwarmOverrides | null;
  volumePath: string;
}

export interface ProvisionDatabaseClients {
  buildDocker: DockerApi;
  managerDocker: DockerApi;
}

export interface ProvisionDatabaseIo {
  onLog?: (line: string) => void;
}

export async function provisionDatabase(
  spec: ProvisionDatabaseSpec,
  clients: ProvisionDatabaseClients,
  io: ProvisionDatabaseIo = {}
): Promise<DeployOutcome> {
  const log = io.onLog ?? (() => undefined);
  const { buildDocker, managerDocker } = clients;
  const { name } = spec;

  log(`▸ ${spec.engineLabel} ${spec.image} as ${name}\n`);

  log(`▸ volume ${name}\n`);
  await ensureVolume(buildDocker, name);
  for (const mount of spec.extraMounts) {
    if (mount.type === "volume") {
      log(`▸ volume ${mount.source}\n`);
      await ensureVolume(buildDocker, mount.source);
    }
  }

  const placementNodeId =
    spec.swarmNodeId ?? (await getSwarmNodeId(buildDocker));
  log(`▸ pinned to node ${placementNodeId}\n`);

  log(`▸ network ${spec.networkName}, secret ${name}-password\n`);
  const [, existing, secretId] = await Promise.all([
    ensureOverlayNetwork(managerDocker, spec.networkName),
    findService(managerDocker, name),
    ensureSecret(managerDocker, `${name}-password`, spec.password),
  ]);

  const desired = databaseServiceSpec({
    databaseName: spec.databaseName,
    externalPort: spec.externalPort,
    extraEnv: spec.env,
    extraMounts: spec.extraMounts,
    image: spec.image,
    name,
    networkName: spec.networkName,
    placementNodeId,
    replicas: spec.replicas,
    resources: spec.resources,
    rootUser: spec.rootUser,
    secretId,
    spec: spec.engine,
    swarmSettings: spec.swarmSettings,
    volumePath: spec.volumePath,
  });

  const serviceSpec = desired as never;

  if (existing) {
    log("▸ updating the existing service\n");
    await managerDocker.getService(existing.ID as string).update({
      ...desired,
      version: existing.Version?.Index,
    } as never);
  } else {
    log("▸ creating the service\n");
    await managerDocker.createService(serviceSpec);
  }

  log("▸ waiting for the Swarm verdict\n");
  const outcome = await awaitSwarmVerdict(managerDocker, name, {
    created: !existing,
  });
  log(
    outcome.accepted
      ? "✓ running\n"
      : `✗ Swarm refused the spec: ${outcome.updateMessage ?? "swarm refused"}\n`
  );

  return outcome;
}
