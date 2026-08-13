import { pipeline } from "node:stream/promises";
import { buildBackupInsert } from "@noddle/backup";
import { decryptSecret, secretContext } from "@noddle/crypto";
import { backups, databases, type servers } from "@noddle/db/schema";
import {
  execArgv,
  execStream,
  quoteArg,
  type SshClient,
} from "@noddle/ssh-executor";
import { scaleServiceAndWait } from "@noddle/swarm-ops";
import { and, eq } from "drizzle-orm";
import { runBackup } from "#backup";
import {
  type RestoreSubject,
  runRestorePipeline,
} from "#backup-run/restore-pipeline";
import {
  assertSafeIdentifier,
  findDatabaseContainer,
} from "#database-runtime";
import { withDeployClients } from "#job-run";
import type { DeployContext } from "#runtime-context";

const SETTLE_MS = 1500;

export interface RestoreRequest {
  backupId?: string;
  databaseId: string;
  destinationId?: string;
  objectKey?: string;
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

type DatabaseRow = NonNullable<
  Awaited<ReturnType<DeployContext["db"]["query"]["databases"]["findFirst"]>>
> & {
  server: typeof servers.$inferSelect;
};

interface DatabaseRestoreLoaded {
  database: DatabaseRow;
  password: string;
  request: RestoreRequest;
}

interface RestoreApplyOpts {
  body: NodeJS.ReadableStream;
  buildClient: SshClient;
  containerId: string;
  database: DatabaseRow;
  managerDocker: Parameters<typeof scaleServiceAndWait>[0];
  password: string;
}

/**
 * Per-engine restore path. A table, not a switch: a sixth engine fails to
 * compile on this Record, same shape as DUMP_SPECS for backup.
 */
const RESTORE_SPECS: Record<
  DatabaseRow["engine"],
  (opts: RestoreApplyOpts) => Promise<void>
> = {
  mariadb: async ({ body, buildClient, containerId, database, password }) => {
    const databaseName =
      database.databaseName ?? database.rootUser ?? database.name;
    await restoreMysqlFamily(buildClient, {
      body,
      clientBinary: "mariadb",
      containerId,
      databaseName,
      password,
      rootUser: database.rootUser ?? "root",
    });
  },
  mongo: async ({ body, buildClient, containerId, database, password }) => {
    const databaseName =
      database.databaseName ?? database.rootUser ?? database.name;
    await restoreMongo(buildClient, {
      body,
      containerId,
      databaseName,
      password,
      rootUser: database.rootUser ?? "mongo",
    });
  },
  mysql: async ({ body, buildClient, containerId, database, password }) => {
    const databaseName =
      database.databaseName ?? database.rootUser ?? database.name;
    await restoreMysqlFamily(buildClient, {
      body,
      clientBinary: "mysql",
      containerId,
      databaseName,
      password,
      rootUser: database.rootUser ?? "root",
    });
  },
  postgres: async ({ body, buildClient, containerId, database }) => {
    const databaseName =
      database.databaseName ?? database.rootUser ?? database.name;
    await restorePostgres(buildClient, {
      body,
      containerId,
      databaseName,
      rootUser: database.rootUser ?? "postgres",
    });
  },
  redis: async ({ body, buildClient, database, managerDocker }) => {
    const serviceName = database.swarmName;
    await scaleServiceAndWait(managerDocker, serviceName, 0);
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    await restoreRedis(buildClient, { body, volume: serviceName });
    await scaleServiceAndWait(managerDocker, serviceName, database.replicas);
  },
};

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

async function applyDatabaseRestore(
  ctx: DeployContext,
  loaded: DatabaseRestoreLoaded,
  body: NodeJS.ReadableStream
): Promise<void> {
  const { database, password } = loaded;

  await withDeployClients(
    ctx,
    database.server,
    async ({ buildClient, managerDocker }) => {
      const containerId = await findDatabaseContainer(
        buildClient,
        database.swarmName
      );
      const databaseName =
        database.databaseName ?? database.rootUser ?? database.name;
      assertSafeIdentifier(databaseName, "database name");
      if (database.rootUser) {
        assertSafeIdentifier(database.rootUser, "database user");
      }

      await RESTORE_SPECS[database.engine]({
        body,
        buildClient,
        containerId,
        database,
        managerDocker,
        password,
      });
    }
  );
}

const databaseRestoreSubject: RestoreSubject<
  RestoreRequest,
  DatabaseRestoreLoaded
> = {
  apply: applyDatabaseRestore,
  load: async (ctx, request) => {
    const database = await ctx.db.query.databases.findFirst({
      where: eq(databases.id, request.databaseId),
      with: { server: true },
    });
    if (!database) {
      throw new Error(`database not found: ${request.databaseId}`);
    }
    const password = decryptSecret(
      database.rootPasswordEncrypted,
      ctx.appKey,
      secretContext.databasePassword(database.id)
    );
    return { database, password, request };
  },
  missingObjectTarget: "database",
  resolveSource: async (ctx, request) =>
    await resolveRestoreSource(ctx, request),
  safetyBackup: async (ctx, loaded, resolved) => {
    const [safety] = await ctx.db
      .insert(backups)
      .values(
        buildBackupInsert({
          database: loaded.database,
          kind: "pre_restore",
          resolved: {
            id: resolved.id,
            prefix: resolved.destination.prefix,
          },
        })
      )
      .returning();
    if (!safety) {
      throw new Error("could not create the safety backup");
    }
    await runBackup(ctx, safety.id);
  },
};

export async function runRestore(
  ctx: DeployContext,
  req: RestoreRequest
): Promise<void> {
  await runRestorePipeline(databaseRestoreSubject, ctx, req);
}
