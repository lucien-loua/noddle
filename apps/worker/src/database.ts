import { databases, envVars } from "@noddle/db/schema";
import { decryptSecret, secretContext } from "@noddle/shared/crypto";
import {
  DATABASE_PORT,
  type DatabaseEngine,
  DEFAULT_DATABASE_IMAGE,
} from "@noddle/shared/database-engines";
import {
  type DockerApi,
  disconnect,
  dockerClient,
  execArgv,
} from "@noddle/ssh-executor";
import { eq } from "drizzle-orm";
import { connectForDeploy, type DeployContext } from "#deploy";
import {
  ensureOverlayNetwork,
  getSwarmNodeId,
  isDeployAccepted,
  readUpdateState,
  removeService,
  waitForRunningTask,
} from "#swarm";

// Docker 29 responds with "volume <name> not found", the older CLI with
// "no such volume" — neither alone is enough. Duplicated from
// `teardown-stack.ts` rather than imported: that module already imports
// `removeSecretIfExists` FROM this one, and the reverse would create a cycle.
const VOLUME_ALREADY_GONE = /not found|no such volume/i;

// Drawn from the shared module: this is the SAME list that the form offers
// and that Zod accepts. Duplicating it here would let the database accept an
// engine the worker wouldn't know how to start.
type Engine = DatabaseEngine;

/**
 * What the engine needs to know to configure itself.
 *
 * An object rather than positional parameters: `databaseName` sits here
 * alongside `rootUser`, and two `string | null` side by side can be swapped
 * without the type system noticing.
 */
interface EngineParams {
  /** `null` for engines without a notion of a named database (Redis). */
  databaseName: string | null;
  /** `null` for engines without a notion of a user (Redis). */
  rootUser: string | null;
  /** The mounted secret's PATH, never the plaintext password. */
  secretPath: string;
}

interface EngineSpec {
  // Receives the mounted secret's PATH (/run/secrets/…), never the plaintext
  // password — that alone would end up in `docker service inspect`.
  command?: (params: EngineParams) => string[];
  env: (params: EngineParams) => string[];
  /**
   * ABSENT when the image contains NO binary capable of probing the engine.
   *
   * This isn't a convenience shortcut: a healthcheck whose command doesn't
   * exist fails in a loop, Swarm kills the container, and it shows up as a
   * deployment that "didn't converge" — with nothing pointing at the missing
   * binary. This is the same `curl` trap already paid for on Compose stacks,
   * and the libSQL image triggers it: measured, it contains only `sqld`, no
   * `curl`, no `wget`, no `nc`, no `sqlite3`.
   *
   * Without a healthcheck, Swarm can no longer block a broken startup — but
   * `waitForRunningTask` still waits for the task to be running, so a
   * container that exits immediately is still detected.
   */
  healthcheck?: (params: EngineParams) => string[];
  /** The default, pinned. Replaced by `databases.image` when it's set. */
  image: string;
  port: number;
  /** Name of the file in /run/secrets, INSIDE the container. */
  secretFile: string;
  /**
   * Permissions of the mounted secret file. `undefined` = `0400`, readable by
   * root only.
   *
   * This is NOT a comfort setting: it depends on WHEN the entrypoint reads
   * the file. Measured on `mongo:7` — its entrypoint does
   * `exec gosu mongodb "$BASH_SOURCE"` on line 22, so it re-execs as the
   * `mongodb` user, and only reads the `_FILE` suffix on line 83, AFTER the
   * switch. With `0400` owned by root it fails with "Permission denied" and
   * the task loops — observed live, `0/1` replicas and four restarts.
   *
   * Postgres, MySQL, and MariaDB read theirs while STILL root: they keep
   * `0400`.
   *
   * Widening to `0444` doesn't lose anything this mechanism protects against:
   * the documented threat is `docker service inspect` and `docker top`, not
   * isolation between processes WITHIN the SAME container — which is the
   * database itself, which has to read this password anyway.
   */
  secretMode?: number;
  volumePath: string;
}

const SECOND_NS = 1_000_000_000;
const SECRET_MODE_OWNER_READ_ONLY = 0o400;
/** See `EngineSpec.secretMode`: required by MongoDB's entrypoint. */
const SECRET_MODE_WORLD_READ_ONLY = 0o444;

/**
 * What each engine wants in order to start.
 *
 * THREE RULES hold this whole table together, and none of them is cosmetic:
 *
 *   · the password arrives through a mounted FILE (`/run/secrets/…`), never
 *     through a spec variable — that would be readable via
 *     `docker service inspect`;
 *   · it must never reach an ARGV, neither the server's nor a client's —
 *     `docker top` would show it. Hence `MYSQL_PWD` and `REDISCLI_AUTH`
 *     instead of `-p`/`-a`, and a config file for Redis;
 *   · the healthcheck binary must be IN the image. Measured image by image,
 *     never assumed: `healthcheck.sh` only exists on MariaDB, `mysqladmin`
 *     only on MySQL.
 */
const ENGINE_SPECS: Record<Engine, EngineSpec> = {
  // MySQL and MariaDB are twins apart from a prefix (`MYSQL_` / `MARIADB_`),
  // but their blocks are still written out in full rather than generated by a
  // shared function: these are two products that have diverged, their images
  // already don't ship the same binaries, and factoring them together would
  // give the false impression they'll move in lockstep.
  mariadb: {
    // `_FILE` is read NATIVELY by the entrypoint. Measured end to end on
    // mariadb:11: container started with a secret file, password from the
    // FILE accepted, wrong password rejected, and nothing in `docker top`.
    //
    // `MARIADB_USER`/`MARIADB_PASSWORD_FILE` create the account the user
    // named IN ADDITION to root, with rights on their database. The image
    // REFUSES `MARIADB_USER=root`, hence the filter: when root is requested
    // there's nothing to create, it already exists.
    env: ({ databaseName, rootUser, secretPath }) => [
      `MARIADB_ROOT_PASSWORD_FILE=${secretPath}`,
      `MARIADB_DATABASE=${databaseName}`,
      ...(rootUser && rootUser !== "root"
        ? [`MARIADB_USER=${rootUser}`, `MARIADB_PASSWORD_FILE=${secretPath}`]
        : []),
    ],
    // `healthcheck.sh --connect` is provided by the official image — measured
    // present under /usr/local/bin, and absent from MySQL's.
    //
    // `--defaults-extra-file` and NOT `MYSQL_PWD`: the variable puts the
    // password in the client's ENVIRONMENT, readable in `/proc/<pid>/environ`
    // by root of the container as well as the host — and the probe runs every
    // three seconds, so the window is short but permanent. MySQL deprecates
    // `MYSQL_PWD` for this exact reason. The config file is written with
    // `umask 077` from the secret, read by the client, then deleted: the same
    // technique as Redis's config file and mongodump's `--config`, already in
    // place elsewhere in this file.
    healthcheck: ({ secretPath }) => [
      "CMD-SHELL",
      `umask 077 && printf '[client]\\npassword=%s\\n' "$(cat ${secretPath})" > /tmp/hc.cnf && healthcheck.sh --defaults-extra-file=/tmp/hc.cnf --connect; rc=$?; rm -f /tmp/hc.cnf; exit $rc`,
    ],
    image: DEFAULT_DATABASE_IMAGE.mariadb,
    port: DATABASE_PORT.mariadb,
    secretFile: "mariadb_password",
    volumePath: "/var/lib/mysql",
  },
  mongo: {
    // The `_FILE` suffix is declared by the entrypoint's `file_env` for
    // `MONGO_INITDB_ROOT_PASSWORD` and `MONGO_INITDB_ROOT_USERNAME` — verified
    // in the image's script, not assumed from documentation.
    env: ({ databaseName, rootUser, secretPath }) => [
      `MONGO_INITDB_ROOT_USERNAME=${rootUser}`,
      `MONGO_INITDB_ROOT_PASSWORD_FILE=${secretPath}`,
      `MONGO_INITDB_DATABASE=${databaseName}`,
    ],
    // WITHOUT credentials, deliberately: a healthcheck doesn't need to prove
    // access, just that the server responds, and passing them would put the
    // password in `mongosh`'s argv.
    healthcheck: () => [
      "CMD-SHELL",
      "mongosh --quiet --eval 'db.adminCommand({ping:1}).ok' || exit 1",
    ],
    image: DEFAULT_DATABASE_IMAGE.mongo,
    port: DATABASE_PORT.mongo,
    secretFile: "mongo_password",
    secretMode: SECRET_MODE_WORLD_READ_ONLY,
    volumePath: "/data/db",
  },
  mysql: {
    env: ({ databaseName, rootUser, secretPath }) => [
      `MYSQL_ROOT_PASSWORD_FILE=${secretPath}`,
      `MYSQL_DATABASE=${databaseName}`,
      ...(rootUser && rootUser !== "root"
        ? [`MYSQL_USER=${rootUser}`, `MYSQL_PASSWORD_FILE=${secretPath}`]
        : []),
    ],
    // `mysqladmin` is in the image, `healthcheck.sh` is NOT — that's a
    // MariaDB-only feature. Measured.
    //
    // Config file rather than `MYSQL_PWD`: see MariaDB just above.
    //
    // **Measured limitation, not to be confused with a protection:
    // `mysqladmin ping` returns 0 ON AN AUTHENTICATION REFUSAL.** Verified
    // live — "Access denied for user 'root'@'127.0.0.1'" followed by
    // `exit=0`. This is documented behavior: the command answers "the server
    // is alive", not "I successfully connected". This probe therefore
    // detects a dead engine, never wrong credentials — unlike MariaDB's
    // `healthcheck.sh --connect`. Another instance of the "a failed deploy
    // exits 0" family: the return code doesn't say what you'd assume.
    healthcheck: ({ secretPath }) => [
      "CMD-SHELL",
      `umask 077 && printf '[client]\\npassword=%s\\n' "$(cat ${secretPath})" > /tmp/hc.cnf && mysqladmin --defaults-extra-file=/tmp/hc.cnf ping -h 127.0.0.1 -u root; rc=$?; rm -f /tmp/hc.cnf; exit $rc`,
    ],
    image: DEFAULT_DATABASE_IMAGE.mysql,
    port: DATABASE_PORT.mysql,
    secretFile: "mysql_password",
    volumePath: "/var/lib/mysql",
  },
  postgres: {
    // `_FILE` is the suffix the official image reads NATIVELY: the
    // entrypoint reads the file itself, no extra script to write.
    env: ({ databaseName, rootUser, secretPath }) => [
      `POSTGRES_USER=${rootUser}`,
      `POSTGRES_PASSWORD_FILE=${secretPath}`,
      `POSTGRES_DB=${databaseName}`,
    ],
    // pg_isready is provided by the official image. No password required:
    // the local connection goes through the socket, which the generated
    // `pg_hba` leaves as `trust`.
    //
    // `-d` is explicit ever since the database name was separated from the
    // user: without it, pg_isready targets the database named after the
    // user, which may no longer exist.
    healthcheck: ({ databaseName, rootUser }) => [
      "CMD-SHELL",
      `pg_isready -U ${rootUser} -d ${databaseName} || exit 1`,
    ],
    image: DEFAULT_DATABASE_IMAGE.postgres,
    port: DATABASE_PORT.postgres,
    secretFile: "postgres_password",
    volumePath: "/var/lib/postgresql/data",
  },
  redis: {
    // `redis-server` has no native `--requirepass-file`. The password is
    // therefore written into a config file generated at startup — via a
    // STREAM (redirected `cat`), never via an ARGUMENT: an argument ends up
    // in `ps`/`docker top`, a config file doesn't. The final process
    // (`redis-server /tmp/redis.conf`) only carries the PATH in its argv.
    command: ({ secretPath }) => [
      "sh",
      "-c",
      `{ printf 'requirepass '; cat ${secretPath}; printf '\\nappendonly yes\\n'; } > /tmp/redis.conf && exec redis-server /tmp/redis.conf`,
    ],
    env: () => [],
    // `REDISCLI_AUTH`, never `-a`: the same rule already applied for the
    // backup dump — `-a` exposes the password in the process's argv.
    healthcheck: ({ secretPath }) => [
      "CMD-SHELL",
      `REDISCLI_AUTH="$(cat ${secretPath})" redis-cli ping || exit 1`,
    ],
    image: DEFAULT_DATABASE_IMAGE.redis,
    port: DATABASE_PORT.redis,
    secretFile: "redis_password",
    volumePath: "/data",
  },
};

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

/**
 * Where the password is mounted INSIDE the container.
 *
 * Exported because changing the password needs to read the CURRENT secret
 * from here — authenticating with the engine without the worker having to
 * decrypt it or have it travel. A second computation of the path would drift
 * the first time `secretFile` is renamed, and the failure would be "file not
 * found" instead of a readable cause.
 */
export function secretPathFor(engine: Engine): string {
  return `/run/secrets/${ENGINE_SPECS[engine].secretFile}`;
}

/**
 * Returned by a function rather than written as a literal at the call site:
 * dockerode's service types contradict themselves between the container-only
 * shape (`Healthcheck`) and a Swarm service's (`HealthCheck` in some of their
 * declarations) — going through a value avoids excess-property checking on a
 * literal tripping over this, exactly like `serviceSpec()` in `swarm.ts`.
 */
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

/** The keys an engine reserves for itself — so the screen can name them. */
export function reservedEnvKeys(
  engine: Engine,
  opts: { databaseName: string | null; rootUser: string | null }
): string[] {
  const spec = ENGINE_SPECS[engine];
  return spec
    .env({
      databaseName: opts.databaseName,
      rootUser: opts.rootUser,
      secretPath: secretPathFor(engine),
    })
    .map((entry) => entry.slice(0, entry.indexOf("=")))
    .sort();
}

function databaseServiceSpec(opts: {
  databaseName: string | null;
  /** The port PUBLISHED on the host. `null` = reachable from the overlay only. */
  externalPort: number | null;
  /** The variables entered by the user, already decrypted. */
  extraEnv: string[];
  /** `databases.image`, or the engine's pinned default. Already resolved here. */
  image: string;
  name: string;
  networkName: string;
  placementNodeId?: string;
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
}) {
  const {
    databaseName,
    externalPort,
    extraEnv,
    image,
    name,
    networkName,
    placementNodeId,
    resources,
    rootUser,
    secretId,
    spec,
  } = opts;

  // `Resources.Limits`/`Reservations`: a key is only set if it has a value,
  // and the whole `Resources` object only if at least one exists. Setting an
  // empty `{ Limits: {} }` isn't neutral — Swarm would then rewrite the spec
  // as "limits explicitly nulled", which would ERASE a limit already in
  // place during a plain spec update for an unrelated reason.
  const limits = {
    ...(resources.memoryLimitBytes === null
      ? {}
      : { MemoryBytes: resources.memoryLimitBytes }),
    ...(resources.cpuLimitNanos === null
      ? {}
      : { NanoCPUs: resources.cpuLimitNanos }),
  };
  const reservations = {
    ...(resources.memoryReservationBytes === null
      ? {}
      : { MemoryBytes: resources.memoryReservationBytes }),
    ...(resources.cpuReservationNanos === null
      ? {}
      : { NanoCPUs: resources.cpuReservationNanos }),
  };
  const resourceSpec = {
    ...(Object.keys(limits).length > 0 ? { Limits: limits } : {}),
    ...(Object.keys(reservations).length > 0
      ? { Reservations: reservations }
      : {}),
  };
  const secretPath = `/run/secrets/${spec.secretFile}`;
  const params: EngineParams = { databaseName, rootUser, secretPath };
  return {
    // Published in `ingress` mode: the port answers on ANY node of the
    // cluster, which routes to whichever hosts the database. `host` would
    // only answer on that one node, which would require knowing which one —
    // and that's exactly what placement can change.
    ...(externalPort
      ? {
          EndpointSpec: {
            Ports: [
              {
                Protocol: "tcp" as const,
                PublishedPort: externalPort,
                PublishMode: "ingress" as const,
                TargetPort: spec.port,
              },
            ],
          },
        }
      : {}),
    Labels: { "traefik.enable": "false" },
    Mode: { Replicated: { Replicas: 1 } },
    Name: name,
    Networks: [{ Target: networkName }],
    TaskTemplate: {
      ...(placementNodeId
        ? { Placement: { Constraints: [`node.id==${placementNodeId}`] } }
        : {}),
      ContainerSpec: {
        ...(spec.command ? { Command: spec.command(params) } : {}),
        Env: mergeEnv(spec.env(params), extraEnv),
        // `Test: ["NONE"]` and not omitting the key: without a declared
        // healthcheck, Swarm inherits the IMAGE's, which we don't control. An
        // image whose built-in healthcheck fails would get the container
        // killed in a loop, and it would read as "didn't converge" with
        // nothing pointing at the cause. `NONE` explicitly disables it.
        Healthcheck: spec.healthcheck
          ? {
              Interval: 3 * SECOND_NS,
              Retries: 5,
              StartPeriod: 5 * SECOND_NS,
              Test: spec.healthcheck(params),
              Timeout: 3 * SECOND_NS,
            }
          : { Test: ["NONE"] },
        Image: image,
        Mounts: [
          { Source: name, Target: spec.volumePath, Type: "volume" as const },
        ],
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
      },
      Networks: [{ Target: networkName }],
      ...(Object.keys(resourceSpec).length > 0
        ? { Resources: resourceSpec }
        : {}),
      RestartPolicy: {
        Condition: "on-failure",
        MaxAttempts: 3,
        Window: 120 * SECOND_NS,
      },
    },
  };
}

export async function provisionDatabase(
  ctx: DeployContext,
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

  const { buildClient, managerClient, sameConnection } = await connectForDeploy(
    ctx,
    database.server
  );

  try {
    const buildDocker = dockerClient(buildClient);
    // Read back from the row, never recomputed from `database.name`: this
    // name is also the VOLUME's, and the host in connection strings already
    // written to attached services. Recomputing it would restart the
    // database on an empty volume. See `@noddle/shared/swarm-names`.
    const name = database.swarmName;

    // The volume is LOCAL to the node hosting it: created on ITS connection,
    // never via the manager when the two differ.
    await ensureVolume(buildDocker, name);

    // ALWAYS pinned, unconditionally. A database is the case where the
    // constraint matters MOST: its named volume only exists on that node,
    // and Swarm doesn't resolve distributed storage. Without a constraint, a
    // multi-node cluster could schedule the database elsewhere — where it
    // would start on an EMPTY volume, with no error, looking like it works.
    //
    // The previous code skipped it when the database was hosted on the
    // manager (`sameConnection`), assuming it had no effect: that's only true
    // on a single-node cluster. Same gap as in `deploy.ts` and `compose.ts`,
    // and this is where it would cost the most.
    const placementNodeId =
      database.server.swarmNodeId ?? (await getSwarmNodeId(buildDocker));
    const managerDocker = sameConnection
      ? buildDocker
      : dockerClient(managerClient);
    await ensureOverlayNetwork(managerDocker, ctx.networkName);

    const existing = await findServiceByName(managerDocker, name);
    // Find-or-create, so calling it on an existing database replaces
    // nothing: a database's password never changes after creation.
    // Cluster-wide like the service that will mount it, so never through
    // `buildDocker` when that differs from the manager.
    const secretId = await ensureSecret(
      managerDocker,
      `${name}-password`,
      password
    );
    const desired = databaseServiceSpec({
      databaseName: database.databaseName,
      externalPort: database.externalPort,
      extraEnv: userEnv,
      // `??` and not a recomputation: a database from BEFORE the `image`
      // column started on its engine's default, and that default is what it
      // must find again. A database that has chosen one keeps it forever —
      // changing the image under an existing volume would start a different
      // engine on top of it.
      image: database.image ?? spec.image,
      name,
      networkName: ctx.networkName,
      placementNodeId,
      // Read as-is: the screen has already converted cores and megabytes
      // into Swarm units, and the spec is REPLACED in full on every
      // provisioning pass — so removing a limit (setting it back to `null`)
      // does make it disappear from the spec, which the builder's `Resources`
      // omission logic ensures.
      resources: {
        cpuLimitNanos: database.cpuLimitNanos,
        cpuReservationNanos: database.cpuReservationNanos,
        memoryLimitBytes: database.memoryLimitBytes,
        memoryReservationBytes: database.memoryReservationBytes,
      },
      rootUser: database.rootUser,
      secretId,
      spec,
    });

    if (existing) {
      // UPDATE, and not just "do nothing if it already exists". Without this
      // branch, changing the published port had NO effect at all: the row
      // changed in the database while the Swarm service kept its old spec,
      // and the screen announced a reachable database that wasn't.
      //
      // The spec is REPLACED in full rather than merged: it's built from the
      // row, so it IS the desired state, and merging would leave behind
      // whatever a previous version had set.
      await managerDocker
        .getService(existing.ID as string)
        .update({ ...desired, version: existing.Version?.Index });
    } else {
      await managerDocker.createService(desired);
      // A CREATE has no UpdateStatus — without waiting for the task, a
      // broken first startup would read as a success.
      await waitForRunningTask(managerDocker, name);
    }

    const state = await readUpdateState(managerDocker, name);
    const accepted = isDeployAccepted(state.updateState);
    await ctx.db
      .update(databases)
      .set({ status: accepted ? "running" : "crashed" })
      .where(eq(databases.id, database.id));
  } catch (err) {
    await ctx.db
      .update(databases)
      .set({ status: "crashed" })
      .where(eq(databases.id, database.id));
    throw err;
  } finally {
    if (managerClient !== buildClient) {
      disconnect(managerClient);
    }
    disconnect(buildClient);
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
  databaseId: string
): Promise<void> {
  const database = await ctx.db.query.databases.findFirst({
    where: eq(databases.id, databaseId),
    with: { server: true },
  });
  if (!database) {
    throw new Error(`database not found: ${databaseId}`);
  }

  const { buildClient, managerClient, sameConnection } = await connectForDeploy(
    ctx,
    database.server
  );
  try {
    const managerDocker = sameConnection
      ? dockerClient(buildClient)
      : dockerClient(managerClient);

    await removeService(managerDocker, database.swarmName);

    let volumeGone = false;
    for (let i = 0; i < 20; i += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: intentional retry
      const res = await execArgv(buildClient, [
        "sudo",
        "docker",
        "volume",
        "rm",
        database.swarmName,
      ]);
      if (res.code === 0 || VOLUME_ALREADY_GONE.test(res.stderr)) {
        volumeGone = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!volumeGone) {
      throw new Error(
        `volume ${database.swarmName} could not be removed — the database was left running as it was`
      );
    }
  } catch (err) {
    await ctx.db
      .update(databases)
      .set({ lastError: err instanceof Error ? err.message : String(err) })
      .where(eq(databases.id, databaseId));
    throw err;
  } finally {
    if (managerClient !== buildClient) {
      disconnect(managerClient);
    }
    disconnect(buildClient);
  }

  // OUTSIDE the SSH block above: `provisionDatabase` opens its OWN
  // connections. The two responsibilities stay separate — this function must
  // remain correct on the day something else calls one without the other.
  await provisionDatabase(ctx, databaseId);
}
