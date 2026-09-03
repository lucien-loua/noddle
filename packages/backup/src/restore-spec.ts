import { pipeline } from "node:stream/promises";
import { setTimeout as sleep } from "node:timers/promises";

import { scaleServiceAndWait } from "@noddle/deploy-engine/ops";
import type { DatabaseEngine } from "@noddle/shared/database-spec";
import { execArgv, execStream, quoteArg } from "@noddle/ssh-executor";
import type { SshClient } from "@noddle/ssh-executor";

const SETTLE_MS = 1500;

export interface DatabaseRestoreTarget {
  databaseName: string | null;
  name: string;
  replicas: number;
  rootUser: string | null;
  swarmName: string;
}

export interface RestoreApplyOpts {
  body: NodeJS.ReadableStream;
  buildClient: SshClient;
  containerId: string;
  database: DatabaseRestoreTarget;
  managerDocker: Parameters<typeof scaleServiceAndWait>[0];
  password: string;
}

export interface RestoreSpec {
  apply: (opts: RestoreApplyOpts) => Promise<void>;
}

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
      stdout.resume();
      await pipeline(opts.body, stdin);
    }
  );

  if (code !== 0) {
    throw new Error(`pg_restore exited with ${code}: ${stderr.slice(0, 800)}`);
  }
}

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

async function restoreRedis(
  client: SshClient,
  opts: { body: NodeJS.ReadableStream; volume: string }
): Promise<void> {
  const helper = `noddle-restore-${Date.now()}`;

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

  await execArgv(client, ["docker", "rm", "-f", helper]);

  if (convert.code !== 0) {
    throw new Error(
      `RDB→AOF conversion failed (code ${convert.code}): ${convert.stderr.slice(0, 500)}`
    );
  }
}

const RESTORE_SPECS: Record<DatabaseEngine, RestoreSpec["apply"]> = {
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
    await sleep(SETTLE_MS);
    await restoreRedis(buildClient, { body, volume: serviceName });
    await scaleServiceAndWait(managerDocker, serviceName, database.replicas);
  },
};

export function restoreSpecFor(engine: DatabaseEngine): RestoreSpec {
  const apply = RESTORE_SPECS[engine];
  if (!apply) {
    throw new Error(`unsupported database engine for restore: ${engine}`);
  }
  return { apply };
}
