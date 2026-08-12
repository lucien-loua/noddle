import {
  ENGINE_SPECS,
  type EngineParams,
  type EngineSpec,
  SECRET_MODE_OWNER_READ_ONLY,
} from "@noddle/database-spec";
import {
  type DatabaseSwarmSettings,
  databases,
  envVars,
} from "@noddle/db/schema";
import { decryptSecret, secretContext } from "@noddle/crypto";
import { SECOND_NS } from "@noddle/shared/deploy-policy";
import { markCrashed, markRunning } from "@noddle/shared/lifecycle";
import { dockerodeWorkloadPolicy } from "@noddle/shared/workload";
import { type DockerApi, execArgv } from "@noddle/ssh-executor";
import {
  ensureOverlayNetwork,
  getSwarmNodeId,
  isDeployAccepted,
  readUpdateState,
  removeService,
  waitForRunningTask,
} from "@noddle/swarm-ops";
import { eq } from "drizzle-orm";
import { withDeployClients } from "#job-run";
import type { DeployContext, RouteOptions } from "#runtime-context";

// Docker 29 responds with "volume <name> not found", the older CLI with
// "no such volume" — neither alone is enough. Duplicated from
// `teardown-stack.ts` rather than imported: that module already imports
// `removeSecretIfExists` FROM this one, and the reverse would create a cycle.
const VOLUME_ALREADY_GONE = /not found|no such volume/i;

/**
 * Merge the USER's variables with the ENGINE's.
 *
 * **The engine always wins.** Docker keeps the LAST occurrence of a key in
 * `Env`: letting a hand-entered `POSTGRES_PASSWORD` through would start the
 * database on a password Noddle doesn't know, while its row, its secret, and
 * the screen would keep announcing the old one — a dashboard that lies, and
 * a database nobody holds the key to anymore.
 *
 * The reverse order (engine defaults then user variables concatenated after)
 * would let a user variable overwrite the stored password — a trap measured
 * elsewhere, not just assumed.
 *
 * Reserved keys are DERIVED from what the engine produces, never kept by
 * hand: a separate list would drift the first time an engine is added.
 */
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
    Volumes?: Array<{ Name?: string }>;
  };
  if (list.Volumes?.some((v) => v.Name === name)) {
    return;
  }
  await docker.createVolume({ Name: name });
}

/**
 * Always against the MANAGER: a secret is replicated cluster state, like a
 * service — never local to a node, unlike a volume.
 */
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
    Data: Buffer.from(plaintext, "utf8").toString("base64"),
    Name: name,
  })) as unknown as { id: string };
  return created.id;
}

/**
 * Best-effort, unlike the volume just below in `runDatabaseTeardown`: an
 * orphaned secret is a low-cost cleanup debt, not lost user data. An error
 * here must never block deletion of the row.
 */
export async function removeSecretIfExists(
  managerDocker: DockerApi,
  name: string
): Promise<void> {
  try {
    const list = (await managerDocker.listSecrets({
      filters: JSON.stringify({ name: [name] }),
    })) as unknown as Array<{ ID?: string; Spec?: { Name?: string } }>;
    const existing = list.find((s) => s.Spec?.Name === name);
    if (existing?.ID) {
      await managerDocker.getSecret(existing.ID).remove();
    }
  } catch {
    // See the comment above: best-effort.
  }
}

async function findServiceByName(docker: DockerApi, name: string) {
  const list = await docker.listServices({
    filters: JSON.stringify({ name: [name] }),
  });
  // Docker-side filter is by PREFIX — already noted in swarm.ts.
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
  // A key is only set if it has a value, and the whole `Resources` object
  // only if at least one exists. Setting an empty `{ Limits: {} }` isn't
  // neutral — Swarm would then rewrite the spec as "limits explicitly
  // nulled", which would ERASE a limit already in place during a plain
  // spec update for an unrelated reason.
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
    Ports?: Array<{
      Protocol: "tcp";
      PublishedPort: number;
      PublishMode: "ingress";
      TargetPort: number;
    }>;
  } = {};
  if (opts.endpointMode) {
    endpointSpec.Mode = opts.endpointMode;
  }
  if (opts.externalPort) {
    endpointSpec.Ports = [
      {
        Protocol: "tcp",
        PublishedPort: opts.externalPort,
        PublishMode: "ingress",
        TargetPort: opts.targetPort,
      },
    ];
  }
  return endpointSpec;
}

function databaseServiceSpec(opts: {
  databaseName: string | null;
  /** The port PUBLISHED on the host. `null` = reachable from the overlay only. */
  externalPort: number | null;
  /** User-added mounts (primary data volume is added separately). */
  extraMounts: Array<{
    source: string;
    target: string;
    type: "bind" | "volume";
  }>;
  /** The variables entered by the user, already decrypted. */
  extraEnv: string[];
  /** `databases.image`, or the engine's pinned default. Already resolved here. */
  image: string;
  name: string;
  networkName: string;
  placementNodeId?: string;
  replicas: number;
  /** Resource limits, raw Swarm units. Each `null` field = no
   *  limit; the object itself is absent when none is set. */
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
  /** Primary data volume path inside the container. */
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

  const placement =
    swarmSettings?.placement ??
    (placementNodeId
      ? { Constraints: [`node.id==${placementNodeId}`] }
      : undefined);

  const networks =
    swarmSettings?.networks && swarmSettings.networks.length > 0
      ? swarmSettings.networks
      : [{ Target: networkName }];

  const mode =
    swarmSettings?.mode ?? ({ Replicated: { Replicas: replicas } } as const);

  const labels = {
    "traefik.enable": "false",
    ...(swarmSettings?.labels ?? {}),
  };

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
        // `Test: ["NONE"]` and not omitting the key: without a declared
        // healthcheck, Swarm inherits the IMAGE's, which we don't control. An
        // image whose built-in healthcheck fails would get the container
        // killed in a loop, and it would read as "didn't converge" with
        // nothing pointing at the cause. `NONE` explicitly disables it.
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
  databaseId: string
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

  // Decrypted HERE, outside the SSH connection: an unreadable value must
  // fail before we've touched the cluster, not in the middle of a spec
  // update.
  const userEnv = (
    await ctx.db.query.envVars.findMany({
      where: eq(envVars.databaseId, database.id),
    })
  ).map(
    (row) =>
      `${row.key}=${decryptSecret(row.valueEncrypted, ctx.appKey, secretContext.envVar(row.id))}`
  );

  try {
    await withDeployClients(
      ctx,
      database.server,
      async ({ buildDocker, managerDocker }) => {
        // Read back from the row, never recomputed from `database.name`:
        // this name is also the VOLUME's, and the host in connection
        // strings already written to attached services. Recomputing it
        // would restart the database on an empty volume. See
        // `@noddle/shared/swarm-names`.
        const name = database.swarmName;

        // The volume is LOCAL to the node hosting it: created on ITS
        // connection, never via the manager when the two differ.
        await ensureVolume(buildDocker, name);
        for (const mount of database.extraMounts) {
          if (mount.type === "volume") {
            // biome-ignore lint/performance/noAwaitInLoops: sequential ensure on one node
            await ensureVolume(buildDocker, mount.source);
          }
        }

        // ALWAYS pinned, unconditionally. A database is the case where the
        // constraint matters MOST: its named volume only exists on that
        // node, and Swarm doesn't resolve distributed storage. Without a
        // constraint, a multi-node cluster could schedule the database
        // elsewhere — where it would start on an EMPTY volume, with no
        // error, looking like it works.
        //
        // The previous code skipped it when the database was hosted on the
        // manager (`sameConnection`), assuming it had no effect: that's
        // only true on a single-node cluster. Same gap as in `deploy.ts`
        // and `compose.ts`, and this is where it would cost the most.
        // Placement from Advanced → Swarm Settings overrides this when set.
        const placementNodeId =
          database.server.swarmNodeId ?? (await getSwarmNodeId(buildDocker));
        await ensureOverlayNetwork(managerDocker, route.networkName);

        const existing = await findServiceByName(managerDocker, name);
        // Find-or-create, so calling it on an existing database replaces
        // nothing: a database's password never changes after creation.
        // Cluster-wide like the service that will mount it, so never
        // through `buildDocker` when that differs from the manager.
        const secretId = await ensureSecret(
          managerDocker,
          `${name}-password`,
          password
        );
        const desired = databaseServiceSpec({
          databaseName: database.databaseName,
          externalPort: database.externalPort,
          extraEnv: userEnv,
          extraMounts: database.extraMounts,
          // `??` and not a recomputation: a database from BEFORE the
          // `image` column started on its engine's default, and that
          // default is what it must find again. When `databases.image` is
          // set (at create or via Advanced → Configuration), provision
          // applies that tag as-is.
          image: database.image ?? spec.image,
          name,
          networkName: route.networkName,
          placementNodeId,
          replicas: database.replicas,
          // Read as-is: the screen has already converted cores and
          // megabytes into Swarm units, and the spec is REPLACED in full
          // on every provisioning pass — so removing a limit (setting it
          // back to `null`) does make it disappear from the spec, which
          // the builder's `Resources` omission logic ensures.
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

        // dockerode's UpdateConfig types require Parallelism/Order even
        // though the Engine accepts partial configs — cast at the
        // boundary.
        const serviceSpec = desired as never;

        if (existing) {
          // UPDATE, and not just "do nothing if it already exists".
          // Without this branch, changing the published port had NO
          // effect at all: the row changed in the database while the
          // Swarm service kept its old spec, and the screen announced a
          // reachable database that wasn't.
          //
          // The spec is REPLACED in full rather than merged: it's built
          // from the row, so it IS the desired state, and merging would
          // leave behind whatever a previous version had set.
          await managerDocker.getService(existing.ID as string).update({
            ...desired,
            version: existing.Version?.Index,
          } as never);
        } else {
          await managerDocker.createService(serviceSpec);
          // A CREATE has no UpdateStatus — without waiting for the task, a
          // broken first startup would read as a success.
          await waitForRunningTask(managerDocker, name);
        }

        const state = await readUpdateState(managerDocker, name);
        const accepted = isDeployAccepted(state.updateState);
        await ctx.db
          .update(databases)
          .set(
            accepted
              ? markRunning(null)
              : markCrashed(null, state.updateMessage ?? "swarm refused")
          )
          .where(eq(databases.id, database.id));
      }
    );
  } catch (err) {
    await ctx.db
      .update(databases)
      .set(markCrashed(null, err instanceof Error ? err.message : String(err)))
      .where(eq(databases.id, database.id));
    throw err;
  }
}

/**
 * "Rebuild Database" — resets the database to zero: the Swarm SERVICE
 * disappears, THEN its named VOLUME, then both are recreated EMPTY.
 *
 * A "reset" button common on this kind of product ("This action will
 * completely reset your database to its initial state. All data, tables, and
 * configurations will be removed.") — deleting the whole database already
 * exists (`runDatabaseTeardown`); this keeps it and only empties its content.
 *
 * Same order and same retry loop as teardown: a named volume stays locked
 * for a few moments by the container that was just removed, and deleting it
 * BEFORE the service would fail every time.
 *
 * The password does NOT change — `provisionDatabase` re-reads the existing
 * secret, never recreated here. A rebuilt database stays reachable with the
 * same credentials, which the screen already shows.
 */
export async function rebuildDatabase(
  ctx: DeployContext,
  route: RouteOptions,
  databaseId: string
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

        const volumeNames = [
          database.swarmName,
          ...database.extraMounts
            .filter((m) => m.type === "volume")
            .map((m) => m.source),
        ];
        for (const volumeName of volumeNames) {
          let volumeGone = false;
          for (let i = 0; i < 20; i += 1) {
            // biome-ignore lint/performance/noAwaitInLoops: intentional retry
            const res = await execArgv(buildClient, [
              "sudo",
              "docker",
              "volume",
              "rm",
              volumeName,
            ]);
            if (res.code === 0 || VOLUME_ALREADY_GONE.test(res.stderr)) {
              volumeGone = true;
              break;
            }
            await new Promise((r) => setTimeout(r, 1000));
          }
          if (!volumeGone) {
            throw new Error(
              `volume ${volumeName} could not be removed — the database was left running as it was`
            );
          }
        }
      }
    );
  } catch (err) {
    await ctx.db
      .update(databases)
      .set({ lastError: err instanceof Error ? err.message : String(err) })
      .where(eq(databases.id, databaseId));
    throw err;
  }

  // OUTSIDE the SSH block above: `provisionDatabase` opens its OWN
  // connections. The two responsibilities stay separate — this function must
  // remain correct on the day something else calls one without the other.
  await provisionDatabase(ctx, route, databaseId);
}
