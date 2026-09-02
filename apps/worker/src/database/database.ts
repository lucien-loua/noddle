import { decryptSecret, secretContext } from "@noddle/crypto";
import {
  ENGINE_SPECS,
  SECRET_MODE_OWNER_READ_ONLY,
} from "@noddle/database-spec";
import type { EngineParams, EngineSpec } from "@noddle/database-spec";
import {
  databaseDeploymentLogs,
  databaseDeployments,
  databases,
  envVars,
} from "@noddle/db/schema";
import type { DatabaseSwarmSettings } from "@noddle/db/schema";
import {
  awaitSwarmVerdict,
  ensureOverlayNetwork,
  getSwarmNodeId,
  dockerodeWorkloadPolicy,
  SECOND_NS,
} from "@noddle/deploy-engine";
import { removeService } from "@noddle/deploy-engine/ops";
import { markCrashed, markRunning } from "@noddle/shared/lifecycle";
import type { DockerApi } from "@noddle/ssh-executor";
import { eq } from "drizzle-orm";

import { withDeployClients } from "#job-run";
import { createLogSink } from "#log-sink";
import type { LogSink } from "#log-sink";
import type {
  BuildOptions,
  DeployContext,
  RouteOptions,
} from "#runtime-context";
import { databaseVolumeNames, removeVolumes } from "#volume/remove";

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
  } catch {}
}

async function findServiceByName(docker: DockerApi, name: string) {
  const list = await docker.listServices({
    filters: JSON.stringify({ name: [name] }),
  });
  return list.find((s) => s.Spec?.Name === name) ?? null;
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
  healthOverride: DatabaseSwarmSettings["healthCheck"]
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
  swarmSettings: DatabaseSwarmSettings | null;
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
  extraMounts: {
    source: string;
    target: string;
    type: "bind" | "volume";
  }[];
  extraEnv: string[];
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
  swarmSettings: DatabaseSwarmSettings | null;
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

export async function provisionDatabase(
  ctx: DeployContext,
  route: RouteOptions,
  build: BuildOptions,
  databaseId: string,
  deploymentId?: string
): Promise<void> {
  const database = await ctx.db.query.databases.findFirst({
    where: eq(databases.id, databaseId),
    with: { server: true },
  });
  if (!database) {
    throw new Error(`database not found: ${databaseId}`);
  }

  const spec = ENGINE_SPECS[database.engine];
  const password = decryptSecret(
    database.rootPasswordEncrypted,
    ctx.appKey,
    secretContext.databasePassword(database.id)
  );

  const userEnv = (
    await ctx.db.query.envVars.findMany({
      where: eq(envVars.databaseId, database.id),
    })
  ).map(
    (row) =>
      `${row.key}=${decryptSecret(row.valueEncrypted, ctx.appKey, secretContext.envVar(row.id))}`
  );

  const image = database.image ?? spec.image;
  const deployment = deploymentId
    ? await ctx.db
        .update(databaseDeployments)
        .set({ image, startedAt: new Date(), status: "deploying" })
        .where(eq(databaseDeployments.id, deploymentId))
        .returning()
        .then((rows) => rows[0])
    : await ctx.db
        .insert(databaseDeployments)
        .values({
          databaseId: database.id,
          image,
          startedAt: new Date(),
          status: "deploying",
        })
        .returning()
        .then((rows) => rows[0]);
  if (!deployment) {
    throw new Error(`could not record a deployment for database ${databaseId}`);
  }

  let sink: LogSink | undefined;
  try {
    sink = await createLogSink({
      deploymentId: deployment.id,
      onChunk: (c) => build.onLog?.(deployment.id, c),
      root: build.logRoot,
    });
    const log = sink;

    await withDeployClients(
      ctx,
      database.server,
      async ({ buildDocker, managerDocker }) => {
        const name = database.swarmName;

        log.write(`▸ ${database.engine} ${image} as ${name}\n`);

        log.write(`▸ volume ${name}\n`);
        await ensureVolume(buildDocker, name);
        for (const mount of database.extraMounts) {
          if (mount.type === "volume") {
            log.write(`▸ volume ${mount.source}\n`);
            await ensureVolume(buildDocker, mount.source);
          }
        }

        const placementNodeId =
          database.server.swarmNodeId ?? (await getSwarmNodeId(buildDocker));
        log.write(`▸ pinned to node ${placementNodeId}\n`);

        log.write(`▸ network ${route.networkName}, secret ${name}-password\n`);
        const [, existing, secretId] = await Promise.all([
          ensureOverlayNetwork(managerDocker, route.networkName),
          findServiceByName(managerDocker, name),
          ensureSecret(managerDocker, `${name}-password`, password),
        ]);
        const desired = databaseServiceSpec({
          databaseName: database.databaseName,
          externalPort: database.externalPort,
          extraEnv: userEnv,
          extraMounts: database.extraMounts,
          image: database.image ?? spec.image,
          name,
          networkName: route.networkName,
          placementNodeId,
          replicas: database.replicas,
          resources: {
            cpuLimitNanos: database.cpuLimitNanos,
            cpuReservationNanos: database.cpuReservationNanos,
            memoryLimitBytes: database.memoryLimitBytes,
            memoryReservationBytes: database.memoryReservationBytes,
          },
          rootUser: database.rootUser,
          secretId,
          spec,
          swarmSettings: database.swarmSettings,
          volumePath: database.volumePath ?? spec.volumePath,
        });

        const serviceSpec = desired as never;

        if (existing) {
          log.write("▸ updating the existing service\n");
          await managerDocker.getService(existing.ID as string).update({
            ...desired,
            version: existing.Version?.Index,
          } as never);
        } else {
          log.write("▸ creating the service\n");
          await managerDocker.createService(serviceSpec);
        }

        log.write("▸ waiting for the Swarm verdict\n");
        const { accepted, ...state } = await awaitSwarmVerdict(
          managerDocker,
          name,
          { created: !existing }
        );
        const message = state.updateMessage ?? "swarm refused";
        log.write(
          accepted ? "✓ running\n" : `✗ Swarm refused the spec: ${message}\n`
        );

        await ctx.db
          .update(databases)
          .set(accepted ? markRunning(null) : markCrashed(null, message))
          .where(eq(databases.id, database.id));
        await ctx.db
          .update(databaseDeployments)
          .set({
            errorMessage: accepted ? null : message,
            finishedAt: new Date(),
            status: accepted ? "succeeded" : "failed",
            swarmUpdateState: state.updateState ?? null,
          })
          .where(eq(databaseDeployments.id, deployment.id));
      }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sink?.write(`✗ ${message}\n`);
    await ctx.db
      .update(databases)
      .set(markCrashed(null, message))
      .where(eq(databases.id, database.id));
    await ctx.db
      .update(databaseDeployments)
      .set({ errorMessage: message, finishedAt: new Date(), status: "failed" })
      .where(eq(databaseDeployments.id, deployment.id));
    throw error;
  } finally {
    if (sink) {
      const { byteSize, storageUrl } = await sink.close();
      await ctx.db
        .insert(databaseDeploymentLogs)
        .values({ byteSize, databaseDeploymentId: deployment.id, storageUrl });
    }
  }
}

export async function rebuildDatabase(
  ctx: DeployContext,
  route: RouteOptions,
  build: BuildOptions,
  databaseId: string,
  deploymentId?: string
): Promise<void> {
  const database = await ctx.db.query.databases.findFirst({
    where: eq(databases.id, databaseId),
    with: { server: true },
  });
  if (!database) {
    throw new Error(`database not found: ${databaseId}`);
  }

  try {
    await withDeployClients(
      ctx,
      database.server,
      async ({ buildClient, managerDocker }) => {
        await removeService(managerDocker, database.swarmName);

        await removeVolumes(
          buildClient,
          databaseVolumeNames(database),
          (volumeName) =>
            `volume ${volumeName} could not be removed, so the database was left running as it was`
        );
      }
    );
  } catch (error) {
    await ctx.db
      .update(databases)
      .set({
        lastError: error instanceof Error ? error.message : String(error),
      })
      .where(eq(databases.id, databaseId));
    throw error;
  }

  await provisionDatabase(ctx, route, build, databaseId, deploymentId);
}
