import type { Readable } from "node:stream";
import { resolveDestination } from "@noddle/backup";
import {
  type BackupDestination,
  deleteObject,
  objectExists,
  objectSize,
  uploadStream,
} from "@noddle/backup-store";
import { backups } from "@noddle/db/schema";
import { decryptSecret, secretContext } from "@noddle/shared/crypto";
import type { DatabaseEngine } from "@noddle/shared/database-engines";
import {
  disconnect,
  execStream,
  quoteArg,
  type SshClient,
} from "@noddle/ssh-executor";
import { eq } from "drizzle-orm";
import { connectTo, type DeployContext } from "#deploy";
import { notify } from "#notify";

// Drawn from the shared module, never copied: an engine added there
// without a dumper here would fail on its first backup, long after it was
// created.
type Engine = DatabaseEngine;

interface DumpSpec {
  /**
   * argv executed INSIDE the database container. Nothing is concatenated
   * by hand: every element is escaped before it reaches the remote shell.
   */
  argv: (opts: {
    containerId: string;
    /**
     * The name of the TARGETED database. Distinct from `rootUser` since
     * migration 0029: the two used to be the same word as long as
     * `POSTGRES_DB=${rootUser}`, and conflating them would dump a database
     * that doesn't exist — or worse, a different one that does.
     */
    databaseName: string | null;
    rootUser: string | null;
  }) => string[];
  /**
   * Variables passed to `docker exec -e`. Postgres has none — the official
   * image's local socket is set to `trust`, so the password NEVER touches
   * a command line. Redis has no such escape hatch.
   */
  env: (opts: {
    databaseName: string | null;
    password: string;
    rootUser: string | null;
  }) => Record<string, string>;
}

const DUMP_SPECS: Record<Engine, DumpSpec> = {
  // MYSQL_PWD rather than `--password=…`: passing the password as an
  // option puts it in the dumper's argv — visible to a `ps` INSIDE the
  // container, and to `docker top` from the host. The variable doesn't show
  // up there. Measured on mariadb:11: a 1,348-byte dump with `MYSQL_PWD`
  // alone, and a wrong password properly rejected.
  mariadb: {
    argv: ({ containerId, databaseName, rootUser }) => [
      "docker",
      "exec",
      "-e",
      "MYSQL_PWD",
      containerId,
      "mariadb-dump",
      `--user=${rootUser ?? "root"}`,
      // `--single-transaction`: a CONSISTENT dump without locking tables,
      // so without interrupting the application during the backup.
      "--single-transaction",
      "--quick",
      databaseName ?? "",
    ],
    env: ({ password }) => ({ MYSQL_PWD: password }),
  },
  mongo: {
    // `--archive` writes ONE stream to standard output rather than a
    // directory tree; `--gzip` compresses inline, so no second process to
    // fit within 2 GB — same reason as pg_dump's `-Fc`.
    // Like restore: the user and database name travel through the
    // ENVIRONMENT, never interpolated into the script. See `restoreMongo`
    // for the full reasoning.
    argv: ({ containerId }) => [
      "docker",
      "exec",
      "-e",
      "MONGO_PWD",
      "-e",
      "MONGO_USER",
      "-e",
      "MONGO_DB",
      containerId,
      "sh",
      "-c",
      "umask 077 && printf 'password: %s\\n' \"$MONGO_PWD\" > /tmp/md.yaml && " +
        'mongodump --config=/tmp/md.yaml -u "$MONGO_USER" ' +
        '--authenticationDatabase admin -d "$MONGO_DB" ' +
        "--archive --gzip; rc=$?; rm -f /tmp/md.yaml; exit $rc",
    ],
    // The user and database name travel through the ENVIRONMENT, like the
    // password: that's what lets the script read them back in quotes
    // instead of seeing them concatenated. `-e NAME` alone, on the docker
    // side, only FORWARDS a variable — it still has to exist in the remote
    // shell, hence their presence here. Forgetting this second side makes
    // mongodump exit 1 on an empty `$MONGO_USER`.
    env: ({ databaseName, password, rootUser }) => ({
      MONGO_DB: databaseName ?? "",
      MONGO_PWD: password,
      MONGO_USER: rootUser ?? "mongo",
    }),
  },
  mysql: {
    argv: ({ containerId, databaseName, rootUser }) => [
      "docker",
      "exec",
      "-e",
      "MYSQL_PWD",
      containerId,
      "mysqldump",
      `--user=${rootUser ?? "root"}`,
      "--single-transaction",
      // `--no-tablespaces`: without it, mysqldump 8 requires the PROCESS
      // privilege, which the account created by the image doesn't have —
      // the dump would fail for a non-root user.
      "--no-tablespaces",
      "--quick",
      databaseName ?? "",
    ],
    env: ({ password }) => ({ MYSQL_PWD: password }),
  },
  postgres: {
    // -Fc: custom format, compressed by zlib INSIDE pg_dump. No
    // `| gzip`, so no second process to fit within 2 GB, and it's the
    // format `pg_restore` expects.
    argv: ({ containerId, databaseName, rootUser }) => [
      "docker",
      "exec",
      containerId,
      "pg_dump",
      "-Fc",
      "-U",
      rootUser ?? "postgres",
      databaseName ?? rootUser ?? "postgres",
    ],
    env: () => ({}),
  },
  redis: {
    // `--rdb -` writes an RDB to standard output. Measured on
    // redis:7-alpine: the stream is pure RDB (the `REDIS0012` magic
    // number) and all of redis-cli's chatter goes to stderr, so nothing
    // pollutes the bytes.
    argv: ({ containerId }) => [
      "docker",
      "exec",
      "-e",
      "REDISCLI_AUTH",
      containerId,
      "redis-cli",
      "--rdb",
      "-",
    ],
    // REDISCLI_AUTH rather than `-a <password>`: the option would put the
    // password in the remote `docker` argv, readable by a `ps` on this
    // machine.
    env: ({ password }) => ({ REDISCLI_AUTH: password }),
  },
};

/**
 * Rejects an identifier that could be read as a FLAG, or carry shell
 * syntax.
 *
 * Same philosophy as `assertNotFlag` in `@noddle/build-engine`, and for the
 * same reason: the worker doesn't trust its callers, even though Zod
 * already validates at the HTTP boundary. Today `sqlIdentifierSchema`
 * restricts these fields to `[a-z0-9_]`, so nothing is exploitable — but a
 * row written through another path (import, seed, hand-written migration)
 * has none of these guarantees, and a database name starting with `-` would
 * be read by `mysql` as an option, not as a database.
 *
 * `mysql` also does NOT honor `--` for its positional database argument in
 * every version: validation is the only reliable defense, not the
 * separator.
 */
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function assertSafeIdentifier(value: string, label: string): void {
  if (!SAFE_IDENTIFIER.test(value)) {
    throw new Error(
      `${label} is not a safe identifier: "${value}" — letters, digits and underscores only, not starting with a digit`
    );
  }
}

/**
 * A database's HISTORICAL Swarm name, the one from before
 * `databases.swarm_name`.
 *
 * Production code no longer calls it: it reads `database.swarmName`,
 * written at creation and backfilled by migration 0016. Otherwise two
 * `main` databases in two environments would produce the SAME service and
 * the SAME volume.
 *
 * Kept for test harnesses, which insert their own rows and need a fixed
 * name to clean up a service and a volume that an interrupted run may have
 * left behind.
 */
export function legacyDatabaseServiceName(name: string): string {
  return `noddle-db-${name}`;
}

/**
 * Finds the container running this database's Swarm task.
 *
 * By the label Swarm sets itself, never by the container's name: the
 * latter carries a task suffix that changes on every restart.
 *
 * No `| grep` or `| head` — these scripts run under `set -o pipefail`, and
 * a consumer that exits early sends a SIGPIPE to the producer, which
 * pipefail turns into a failed pipeline. It's a RACE: the same code passes
 * and fails about half the time. We split it out here, in TypeScript.
 */
export async function findDatabaseContainer(
  client: SshClient,
  serviceName: string
): Promise<string> {
  const { code, stderr, value } = await execStream(
    client,
    `docker ps --no-trunc --filter ${quoteArg(`label=com.docker.swarm.service.name=${serviceName}`)} --format ${quoteArg("{{.ID}}")}`,
    async ({ stdout }) => {
      let out = "";
      stdout.setEncoding("utf8");
      for await (const chunk of stdout) {
        out += chunk as string;
      }
      return out;
    }
  );
  if (code !== 0) {
    throw new Error(`docker ps failed (code ${code}): ${stderr}`);
  }
  const id = value
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "");
  if (!id) {
    throw new Error(
      `no running container for ${serviceName} — is the database up?`
    );
  }
  return id;
}

/**
 * Runs an end-to-end backup and updates the row.
 *
 * The whole fix boils down to one sentence: **we never conclude from the
 * fact that the stream ended.** A `pg_dump` killed midway closes its
 * output cleanly, the object uploads with no error, and nothing in the
 * bytes says any are missing — measured against RustFS. Only the exit code
 * tells a backup apart from half a backup, and a corrupted backup
 * presented as good is worse than no backup at all.
 */
export async function runBackup(
  ctx: DeployContext,
  backupId: string
): Promise<void> {
  const backup = await ctx.db.query.backups.findFirst({
    where: eq(backups.id, backupId),
    with: { database: { with: { server: true } } },
  });
  if (!backup) {
    throw new Error(`backup not found: ${backupId}`);
  }
  const { database } = backup;
  // `backup.destinationId` FIRST: it's the destination already decided
  // when the row was created (`buildBackupInsert`), the one whose prefix
  // is ALREADY in `backup.objectKey` — revisiting it here would break the
  // agreement between the two if `database.s3DestinationId` changed in the
  // meantime. Falling back to `database.s3DestinationId` only serves rows
  // written through a path other than `buildBackupInsert` (test harnesses,
  // historical data).
  const { destination, id: destinationId } = await resolveDestination(
    ctx.db,
    ctx.appKey,
    backup.destinationId ?? database.s3DestinationId
  );

  const password = decryptSecret(
    database.rootPasswordEncrypted,
    ctx.appKey,
    secretContext.databasePassword(database.id)
  );
  const spec = DUMP_SPECS[database.engine];

  await ctx.db
    .update(backups)
    // `destinationId` written HERE, at the moment the upload really
    // targets this bucket: a restore or a retention prune must know WHERE
    // the object went, not which destination the database prefers today.
    .set({ destinationId, startedAt: new Date(), status: "running" })
    .where(eq(backups.id, backupId));

  // The connection is to the server that HOSTS the database: the volume
  // and the container only exist on that node. No need for the manager
  // here — we're not touching the service's spec, only its container.
  const client = await connectTo(ctx, database.server);

  try {
    const containerId = await findDatabaseContainer(client, database.swarmName);

    const env = spec.env({
      databaseName: database.databaseName,
      password,
      rootUser: database.rootUser,
    });
    const envPrefix = Object.entries(env)
      .map(([k, v]) => `${k}=${quoteArg(v)}`)
      .join(" ");
    if (database.databaseName) {
      assertSafeIdentifier(database.databaseName, "database name");
    }
    if (database.rootUser) {
      assertSafeIdentifier(database.rootUser, "database user");
    }
    const argv = spec
      .argv({
        containerId,
        databaseName: database.databaseName,
        rootUser: database.rootUser,
      })
      .map(quoteArg)
      .join(" ");
    const command = envPrefix === "" ? argv : `${envPrefix} ${argv}`;

    const { code, stderr } = await execStream(client, command, (io) =>
      uploadStream(destination, backup.objectKey, io.stdout as Readable)
    );

    if (code !== 0) {
      // The object is there and it's VALID as far as S3 is concerned:
      // that's precisely why it has to be removed. Leaving it and just
      // marking it `failed` would be enough for the interface, but a
      // bucket that holds half-dumps eventually gets used by someone who
      // won't read the status column.
      await deleteObject(destination, backup.objectKey).catch(() => {
        // An orphaned object is less serious than hiding the real cause.
      });
      throw new Error(
        `the dumper exited with ${code} — backup incomplete, object deleted: ${stderr.slice(0, 500)}`
      );
    }

    // The size comes from a HEAD, not from counting bytes as they went by:
    // what matters is what the bucket actually holds.
    const sizeBytes = await uploadedSize(destination, backup.objectKey);

    await ctx.db
      .update(backups)
      .set({ finishedAt: new Date(), sizeBytes, status: "completed" })
      .where(eq(backups.id, backupId));

    // The prune happens AFTER recording success, never before: pruning
    // first would shrink the window during which there's still something
    // to restore if this dump fails. It also isn't allowed to fail a
    // backup that itself succeeded.
    try {
      const { pruneBackups } = await import("#backup-sweep");
      await pruneBackups(ctx, database.id);
    } catch {
      // A failed prune leaves extra objects around, which costs storage —
      // not data. The next sweep will retry.
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await ctx.db
      .update(backups)
      .set({
        errorMessage: message,
        finishedAt: new Date(),
        status: "failed",
      })
      .where(eq(backups.id, backupId));
    await notify(ctx, {
      detail: message,
      resource: database.name,
      type: "backup_failed",
    });
    throw err;
  } finally {
    disconnect(client);
  }
}

/** Reads back the real size. Separates the "missing" case from an actual
 *  failure. */
async function uploadedSize(
  destination: BackupDestination,
  key: string
): Promise<number> {
  if (!(await objectExists(destination, key))) {
    throw new Error(
      `the upload finished but object ${key} is missing from the bucket`
    );
  }
  return await objectSize(destination, key);
}
