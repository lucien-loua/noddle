import type { DatabaseEngine } from "@noddle/database-spec";

/**
 * How to dump one engine: argv for `docker exec` + env that carries secrets
 * (never argv flags like `-p` / `-a`).
 *
 * Lives next to `BACKUP_EXTENSION` — backup domain, not `@noddle/database-spec`
 * runtime (image / port / healthcheck). A sixth engine must fill this table.
 */
export interface DumpSpec {
  argv: (opts: {
    containerId: string;
    databaseName: string | null;
    rootUser: string | null;
  }) => string[];
  env: (opts: {
    databaseName: string | null;
    password: string;
    rootUser: string | null;
  }) => Record<string, string>;
}

const DUMP_SPECS: Record<DatabaseEngine, DumpSpec> = {
  mariadb: {
    argv: ({ containerId, databaseName, rootUser }) => [
      "docker",
      "exec",
      "-e",
      "MYSQL_PWD",
      containerId,
      "mariadb-dump",
      `--user=${rootUser ?? "root"}`,
      "--single-transaction",
      "--quick",
      databaseName ?? "",
    ],
    env: ({ password }) => ({ MYSQL_PWD: password }),
  },
  mongo: {
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
      "--no-tablespaces",
      "--quick",
      databaseName ?? "",
    ],
    env: ({ password }) => ({ MYSQL_PWD: password }),
  },
  postgres: {
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
    env: ({ password }) => ({ REDISCLI_AUTH: password }),
  },
};

/** A sixth engine fails to compile on DUMP_SPECS, not at runtime here. */
export function dumpSpecFor(engine: DatabaseEngine): DumpSpec {
  const spec = DUMP_SPECS[engine];
  if (!spec) {
    throw new Error(`unsupported database engine for dump: ${engine}`);
  }
  return spec;
}
