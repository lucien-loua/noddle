import { pipeline } from "node:stream/promises";
import { buildBackupInsert, resolveDestination } from "@noddle/backup";
import { downloadStream, objectExists } from "@noddle/backup-store";
import { backups, databases } from "@noddle/db/schema";
import { decryptSecret, secretContext } from "@noddle/shared/crypto";
import type { DockerApi } from "@noddle/ssh-executor";
import {
  disconnect,
  execArgv,
  execStream,
  quoteArg,
  type SshClient,
} from "@noddle/ssh-executor";
import { waitForRunningTask } from "@noddle/swarm-ops";
import { and, eq } from "drizzle-orm";
import {
  assertSafeIdentifier,
  findDatabaseContainer,
  runBackup,
} from "#backup";
import { connectForDeploy, type DeployContext } from "#runtime-context";

const SETTLE_MS = 1500;
const SCALE_TIMEOUT_MS = 120_000;

export interface RestoreRequest {
  backupId?: string;
  databaseId: string;
  destinationId?: string;
  objectKey?: string;
}

/**
 * Sets a service's replica count and waits until it's actually true.
 *
 * `docker service update` returns control BEFORE convergence — the same
 * trap as for a deployment, and here it counts double: writing to the
 * volume while the container is still running would corrupt exactly what
 * we're restoring.
 */
async function scaleServiceAndWait(
  docker: DockerApi,
  serviceName: string,
  replicas: number
): Promise<void> {
  const list = await docker.listServices({
    filters: JSON.stringify({ name: [serviceName] }),
  });
  const existing = list.find((s) => s.Spec?.Name === serviceName);
  if (!existing) {
    throw new Error(`Swarm service not found: ${serviceName}`);
  }

  const spec = existing.Spec as Record<string, unknown>;
  await docker.getService(existing.ID as string).update({
    ...spec,
    Mode: { Replicated: { Replicas: replicas } },
    version: existing.Version?.Index,
  });

  if (replicas === 0) {
    const deadline = Date.now() + SCALE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      // biome-ignore lint/performance/noAwaitInLoops: deliberate polling loop
      const tasks = await docker.listTasks({
        filters: JSON.stringify({ service: [serviceName] }),
      });
      const alive = tasks.filter((t) => {
        const state = (t as { Status?: { State?: string } }).Status?.State;
        return (
          state !== "shutdown" && state !== "failed" && state !== "complete"
        );
      });
      if (alive.length === 0) {
        return;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(`service ${serviceName} did not scale down to 0 replicas`);
  }
  await waitForRunningTask(docker, serviceName);
}

/**
 * Postgres: `pg_restore` reads the archive on its standard input, while the
 * server keeps running. Nothing to stop.
 *
 * `--exit-on-error` is deliberate. Without it, pg_restore continues after an
 * error and exits with 0 and warnings: a partial restore would then be
 * indistinguishable from a successful one, precisely the bug refused
 * elsewhere for deployments and backups. `--clean --if-exists` drops what
 * exists without failing on what's missing.
 */
async function restorePostgres(
  client: SshClient,
  opts: {
    body: NodeJS.ReadableStream;
    containerId: string;
    databaseName: string;
    rootUser: string;
  }
): Promise<void> {
  const argv = [
    "docker",
    "exec",
    "-i",
    opts.containerId,
    "pg_restore",
    "--clean",
    "--if-exists",
    "--exit-on-error",
    "-U",
    opts.rootUser,
    "-d",
    opts.databaseName,
  ];

  const { code, stderr } = await execStream(
    client,
    argv.map(quoteArg).join(" "),
    async ({ stdin, stdout }) => {
      // The standard output MUST be drained: without a reader, the channel
      // window fills up and the remote process blocks on writing.
      stdout.resume();
      await pipeline(opts.body, stdin);
    }
  );

  if (code !== 0) {
    throw new Error(`pg_restore exited with ${code}: ${stderr.slice(0, 800)}`);
  }
}

/**
 * MySQL and MariaDB: the client reads the SQL on its STANDARD INPUT, server
 * running. Nothing to stop, as with `pg_restore`.
 *
 * `MYSQL_PWD` and never `-p<password>`: the option would put the password in
 * argv, readable via `docker top`. Same rule as the dump.
 *
 * The dump comes from `--databases`, so it carries its own `USE`: it's the
 * dump that picks the database, and `-D` only serves to give a valid
 * starting point.
 */
async function restoreMysqlFamily(
  client: SshClient,
  opts: {
    body: NodeJS.ReadableStream;
    clientBinary: "mariadb" | "mysql";
    containerId: string;
    databaseName: string;
    password: string;
    rootUser: string;
  }
): Promise<void> {
  const argv = [
    "docker",
    "exec",
    "-i",
    "-e",
    `MYSQL_PWD=${opts.password}`,
    opts.containerId,
    opts.clientBinary,
    `--user=${opts.rootUser}`,
    opts.databaseName,
  ];

  const { code, stderr } = await execStream(
    client,
    argv.map(quoteArg).join(" "),
    async ({ stdin, stdout }) => {
      stdout.resume();
      await pipeline(opts.body, stdin);
    }
  );

  if (code !== 0) {
    throw new Error(
      `${opts.clientBinary} exited with ${code}: ${stderr.slice(0, 800)}`
    );
  }
}

/**
 * MongoDB: `mongorestore` reads the archive on its standard input.
 *
 * `--drop` is deliberate, and it's the counterpart to pg_restore's
 * `--clean`: without it, restoring MERGES with what's already there, and a
 * collection deleted since the backup would stay deleted while another
 * would get its documents duplicated. A restore must reproduce the backup's
 * state, not a mix.
 *
 * The password goes through a config file written on the fly, as with the
 * dump: `mongorestore` has no equivalent to `MYSQL_PWD`.
 */
async function restoreMongo(
  client: SshClient,
  opts: {
    body: NodeJS.ReadableStream;
    containerId: string;
    databaseName: string;
    password: string;
    rootUser: string;
  }
): Promise<void> {
  // NO interpolation in the script: the user and database name go through
  // the ENVIRONMENT and are read back inside quotes. They're currently
  // constrained to `[a-z0-9_]` by Zod, so nothing is exploitable as things
  // stand — but this is the only command in the repo that used to be built
  // via concatenation instead of `quoteArg`, and a value written through a
  // different path (import, seed, migration) wouldn't have any of these
  // guarantees. The shell must never see these words as CODE.
  const script =
    "umask 077 && printf 'password: %s\\n' \"$MONGO_PWD\" > /tmp/mr.yaml && " +
    'mongorestore --config=/tmp/mr.yaml -u "$MONGO_USER" ' +
    '--authenticationDatabase admin --nsInclude="$MONGO_DB.*" ' +
    "--drop --archive --gzip; rc=$?; rm -f /tmp/mr.yaml; exit $rc";
  const argv = [
    "docker",
    "exec",
    "-i",
    "-e",
    `MONGO_PWD=${opts.password}`,
    "-e",
    `MONGO_USER=${opts.rootUser}`,
    "-e",
    `MONGO_DB=${opts.databaseName}`,
    opts.containerId,
    "sh",
    "-c",
    script,
  ];

  const { code, stderr } = await execStream(
    client,
    argv.map(quoteArg).join(" "),
    async ({ stdin, stdout }) => {
      stdout.resume();
      await pipeline(opts.body, stdin);
    }
  );

  if (code !== 0) {
    throw new Error(
      `mongorestore exited with ${code}: ${stderr.slice(0, 800)}`
    );
  }
}

/**
 * Redis: there's no command to load an RDB on a live server. The service
 * has to be stopped, the file placed into the volume, then restarted.
 *
 * And that's where the trap is, measured on a real VM: the database runs
 * with `--appendonly yes`, so on startup Redis loads the AOF and IGNORES the
 * RDB. Placing dump.rdb and restarting therefore does nothing at all —
 * measured: the key added after the backup was still there. Clearing the
 * AOF isn't enough either: without an AOF, Redis 7 starts EMPTY and builds a
 * fresh one, it never falls back to the RDB. Also measured, and it's the
 * worse of the two — a "successful" restore that leaves an empty database.
 *
 * Hence the DISPOSABLE container: it mounts the same volume, starts with
 * `--appendonly no` (so it does load the RDB), then we turn on the AOF live,
 * which makes it rewrite from the loaded data. The volume then contains an
 * AOF matching the backup, and the real service just needs to restart with
 * its usual, unchanged arguments.
 */
async function restoreRedis(
  client: SshClient,
  opts: { body: NodeJS.ReadableStream; volume: string }
): Promise<void> {
  const helper = `noddle-restore-${Date.now()}`;

  // 1. Place the RDB and clear the AOF, FROM a container mounted on the volume.
  const writeArgv = [
    "docker",
    "run",
    "--rm",
    "-i",
    "-v",
    `${opts.volume}:/data`,
    "alpine",
    "sh",
    "-c",
    "rm -rf /data/appendonlydir /data/appendonly.aof && cat > /data/dump.rdb",
  ];
  const write = await execStream(
    client,
    writeArgv.map(quoteArg).join(" "),
    async ({ stdin, stdout }) => {
      stdout.resume();
      await pipeline(opts.body, stdin);
    }
  );
  if (write.code !== 0) {
    throw new Error(
      `writing the RDB into the volume failed (code ${write.code}): ${write.stderr.slice(0, 500)}`
    );
  }

  // 2. The disposable container converts the RDB into an AOF.
  const convert = await execArgv(client, [
    "sh",
    "-c",
    [
      `docker run -d --name ${helper} -v ${opts.volume}:/data redis:7-alpine`,
      "redis-server --appendonly no --dir /data --dbfilename dump.rdb >/dev/null",
      "&& sleep 3",
      `&& docker exec ${helper} redis-cli CONFIG SET appendonly yes >/dev/null`,
      "&& for i in $(seq 1 30); do",
      `  s=$(docker exec ${helper} redis-cli INFO persistence | tr -d '\\r' | sed -n 's/^aof_rewrite_in_progress://p');`,
      '  [ "$s" = "0" ] && break; sleep 1;',
      "done",
      `&& docker exec ${helper} redis-cli SHUTDOWN NOSAVE >/dev/null 2>&1 || true`,
    ].join(" "),
  ]);

  // The disposable container is removed no matter what: leaving one behind
  // would block the next restore on a name already taken.
  await execArgv(client, ["docker", "rm", "-f", helper]);

  if (convert.code !== 0) {
    throw new Error(
      `RDB→AOF conversion failed (code ${convert.code}): ${convert.stderr.slice(0, 500)}`
    );
  }
}

async function resolveRestoreSource(
  ctx: DeployContext,
  req: RestoreRequest
): Promise<{ destinationId: string | null; objectKey: string }> {
  if (req.backupId) {
    const backup = await ctx.db.query.backups.findFirst({
      where: and(
        eq(backups.id, req.backupId),
        eq(backups.databaseId, req.databaseId)
      ),
    });
    if (!backup) {
      throw new Error(
        "backup not found for this database — cross-database restore refused"
      );
    }
    if (backup.status !== "completed") {
      throw new Error(
        `backup is in status "${backup.status}": only a completed backup can be restored`
      );
    }
    const { destinationId, objectKey } = backup;
    return { destinationId, objectKey };
  }

  if (req.destinationId && req.objectKey) {
    const { destinationId, objectKey } = req;
    return { destinationId, objectKey };
  }

  throw new Error("restore requires backupId, or destinationId and objectKey");
}

export async function runRestore(
  ctx: DeployContext,
  req: RestoreRequest
): Promise<void> {
  const database = await ctx.db.query.databases.findFirst({
    where: eq(databases.id, req.databaseId),
    with: { server: true },
  });
  if (!database) {
    throw new Error(`database not found: ${req.databaseId}`);
  }

  const { destinationId, objectKey } = await resolveRestoreSource(ctx, req);

  // Decrypted HERE and not at the call site: three of the five engines need
  // it to restore (the MySQL/MariaDB SQL client, `mongorestore`), and
  // Postgres doesn't want it — its local socket is set to `trust`.
  const password = decryptSecret(
    database.rootPasswordEncrypted,
    ctx.appKey,
    secretContext.databasePassword(database.id)
  );
  // THE ONE the object actually went to — never re-picked from "current"
  // database prefs.
  const { destination, id: resolvedDestinationId } = await resolveDestination(
    ctx.db,
    ctx.appKey,
    destinationId
  );

  // BEFORE any destructive action. The database row is not proof that the
  // object is still there.
  if (!(await objectExists(destination, objectKey))) {
    throw new Error(
      `object ${objectKey} is missing from the bucket — restore refused before touching the database`
    );
  }

  // The safety net: the restore becomes reversible. Same builder as
  // `triggerBackup`/`sweepBackups`: the safety net goes into the SAME
  // bucket as what we're restoring, with the extension of the REAL dumper —
  // never a ternary that would guess `.rdb` for a MySQL SQL dump.
  const [safety] = await ctx.db
    .insert(backups)
    .values(
      buildBackupInsert({
        database,
        kind: "pre_restore",
        resolved: { id: resolvedDestinationId, prefix: destination.prefix },
      })
    )
    .returning();
  if (!safety) {
    throw new Error("could not create the safety backup");
  }
  await runBackup(ctx, safety.id);

  const serviceName = database.swarmName;
  const { buildClient, managerClient } = await connectForDeploy(
    ctx,
    database.server
  );

  try {
    const body = await downloadStream(destination, objectKey);

    // AN EXHAUSTIVE SWITCH, never an `if postgres / else`. The previous
    // shape made EVERY non-Postgres engine fall through to the REDIS path:
    // measured on a real MySQL database, the restore wrote a `dump.rdb`
    // into `/var/lib/mysql`, started a disposable Redis container on that
    // volume, and reported SUCCESS without having restored anything. The
    // volume survived by luck — MySQL ignores a file it doesn't recognize —
    // but the deleted marker never came back.
    //
    // `default` THROWS: an engine added tomorrow without a restore path
    // fails loudly, it doesn't silently restore into the wrong one.
    const containerId = await findDatabaseContainer(buildClient, serviceName);
    const databaseName =
      database.databaseName ?? database.rootUser ?? database.name;
    // Checked HERE, once, for all five engines: they end up as positionals
    // and as options for remote clients.
    assertSafeIdentifier(databaseName, "database name");
    if (database.rootUser) {
      assertSafeIdentifier(database.rootUser, "database user");
    }

    switch (database.engine) {
      case "postgres":
        await restorePostgres(buildClient, {
          body,
          containerId,
          // `-d` targets the DATABASE, `-U` the user: two distinct things
          // since migration 0029. Confusing them would restore into a
          // database that doesn't exist — or, worse, into another one that
          // does.
          databaseName,
          rootUser: database.rootUser ?? "postgres",
        });
        break;
      case "mariadb":
      case "mysql":
        await restoreMysqlFamily(buildClient, {
          body,
          clientBinary: database.engine === "mariadb" ? "mariadb" : "mysql",
          containerId,
          databaseName,
          password,
          rootUser: database.rootUser ?? "root",
        });
        break;
      case "mongo":
        await restoreMongo(buildClient, {
          body,
          containerId,
          databaseName,
          password,
          rootUser: database.rootUser ?? "mongo",
        });
        break;
      case "redis": {
        // Swarm commands go through the MANAGER — a worker refuses
        // `docker service update`, it doesn't hold the cluster's state. The
        // volume, on the other hand, only exists on the database's node.
        const { dockerClient } = await import("@noddle/ssh-executor");
        const managerDocker = dockerClient(managerClient);

        await scaleServiceAndWait(managerDocker, serviceName, 0);
        // Swarm returns control as soon as the task is marked stopped; give
        // the daemon a few moments to actually release the volume.
        await new Promise((r) => setTimeout(r, SETTLE_MS));

        await restoreRedis(buildClient, { body, volume: serviceName });

        await scaleServiceAndWait(
          managerDocker,
          serviceName,
          database.replicas
        );
        break;
      }
      default: {
        const jamais: never = database.engine;
        throw new Error(`no restore path for engine: ${jamais}`);
      }
    }
  } finally {
    if (managerClient !== buildClient) {
      disconnect(managerClient);
    }
    disconnect(buildClient);
  }
}
