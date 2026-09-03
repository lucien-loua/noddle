export const DATABASE_ENGINES = [
  "postgres",
  "mysql",
  "mariadb",
  "mongo",
  "redis",
] as const;

export type DatabaseEngine = (typeof DATABASE_ENGINES)[number];

export const DEFAULT_DATABASE_USER: Record<DatabaseEngine, string | null> = {
  mariadb: "mariadb",
  mongo: "mongo",
  mysql: "mysql",
  postgres: "postgres",
  redis: null,
};

export const HAS_NAMED_DATABASE: Record<DatabaseEngine, boolean> = {
  mariadb: true,
  mongo: true,
  mysql: true,
  postgres: true,
  redis: false,
};

export const DATABASE_ENGINE_LABEL: Record<DatabaseEngine, string> = {
  mariadb: "MariaDB",
  mongo: "MongoDB",
  mysql: "MySQL",
  postgres: "PostgreSQL",
  redis: "Redis",
};

export const ENGINE_ENV_PREFIX: Record<DatabaseEngine, string> = {
  mariadb: "MARIADB_",
  mongo: "MONGO_",
  mysql: "MYSQL_",
  postgres: "POSTGRES_",
  redis: "REDIS_",
};

export const DEFAULT_DATABASE_IMAGE: Record<DatabaseEngine, string> = {
  mariadb: "mariadb:11",
  mongo: "mongo:7",
  mysql: "mysql:8",
  postgres: "postgres:17-alpine",
  redis: "redis:7-alpine",
};

export const DATABASE_PORT: Record<DatabaseEngine, number> = {
  mariadb: 3306,
  mongo: 27_017,
  mysql: 3306,
  postgres: 5432,
  redis: 6379,
};

export const DEFAULT_DATABASE_VOLUME_PATH: Record<DatabaseEngine, string> = {
  mariadb: "/var/lib/mysql",
  mongo: "/data/db",
  mysql: "/var/lib/mysql",
  postgres: "/var/lib/postgresql/data",
  redis: "/data",
};

export interface EngineParams {
  databaseName: string | null;
  rootUser: string | null;
  secretPath: string;
}

export interface ConnectionUrlParams {
  databaseName: string | null;
  host: string;
  password: string;
  portOverride?: number;
  rootUser: string | null;
}

export interface PasswordChangeSpec {
  input: (params: { password: string; rootUser: string }) => string;
  script: (params: { rootUser: string; secretPath: string }) => string;
}

export interface EngineSpec {
  command?: (params: EngineParams) => string[];
  connectionUrl: (params: ConnectionUrlParams) => string;
  env: (params: EngineParams) => string[];
  healthcheck?: (params: EngineParams) => string[];
  image: string;
  passwordChange: PasswordChangeSpec;
  port: number;
  secretFile: string;
  secretMode?: number;
  volumePath: string;
}

function mysqlLiteral(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("'", "''");
}

function psqlSetLiteral(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

function mysqlFamilyPasswordChange(
  clientBinary: "mariadb" | "mysql"
): PasswordChangeSpec {
  return {
    input: ({ password, rootUser }) => {
      const literal = mysqlLiteral(password);
      const accounts = [
        `'${mysqlLiteral(rootUser)}'@'%'`,
        "'root'@'%'",
        "'root'@'localhost'",
      ];
      return `${accounts
        .map(
          (account) =>
            `ALTER USER IF EXISTS ${account} IDENTIFIED BY '${literal}';`
        )
        .join("\n")}\nFLUSH PRIVILEGES;\n`;
    },
    script: ({ secretPath }) =>
      `umask 077 && { printf '[client]\\npassword='; cat ${secretPath}; printf '\\n'; } > /tmp/np.cnf && ${clientBinary} --defaults-extra-file=/tmp/np.cnf --user=root; rc=$?; rm -f /tmp/np.cnf; exit $rc`,
  };
}

export const SECRET_MODE_OWNER_READ_ONLY = 0o400;
export const SECRET_MODE_WORLD_READ_ONLY = 0o444;

export const ENGINE_SPECS: Record<DatabaseEngine, EngineSpec> = {
  mariadb: {
    connectionUrl: ({
      databaseName,
      host,
      password,
      portOverride,
      rootUser,
    }) => {
      const port = portOverride ?? DATABASE_PORT.mariadb;
      const dbName = databaseName ?? rootUser;
      return `mysql://${rootUser}:${password}@${host}:${port}/${dbName}`;
    },
    env: ({ databaseName, rootUser, secretPath }) => [
      `MARIADB_ROOT_PASSWORD_FILE=${secretPath}`,
      `MARIADB_DATABASE=${databaseName ?? rootUser}`,
      ...(rootUser && rootUser !== "root"
        ? [`MARIADB_USER=${rootUser}`, `MARIADB_PASSWORD_FILE=${secretPath}`]
        : []),
    ],
    healthcheck: ({ secretPath }) => [
      "CMD-SHELL",
      `umask 077 && printf '[client]\\npassword=%s\\n' "$(cat ${secretPath})" > /tmp/hc.cnf && healthcheck.sh --defaults-extra-file=/tmp/hc.cnf --connect; rc=$?; rm -f /tmp/hc.cnf; exit $rc`,
    ],
    image: DEFAULT_DATABASE_IMAGE.mariadb,
    passwordChange: mysqlFamilyPasswordChange("mariadb"),
    port: DATABASE_PORT.mariadb,
    secretFile: "mariadb_password",
    volumePath: DEFAULT_DATABASE_VOLUME_PATH.mariadb,
  },
  mongo: {
    connectionUrl: ({
      databaseName,
      host,
      password,
      portOverride,
      rootUser,
    }) => {
      const port = portOverride ?? DATABASE_PORT.mongo;
      const dbName = databaseName ?? rootUser;
      return `mongodb://${rootUser}:${password}@${host}:${port}/${dbName}?authSource=admin`;
    },
    env: ({ databaseName, rootUser, secretPath }) => [
      `MONGO_INITDB_ROOT_USERNAME=${rootUser}`,
      `MONGO_INITDB_ROOT_PASSWORD_FILE=${secretPath}`,
      `MONGO_INITDB_DATABASE=${databaseName ?? rootUser}`,
    ],
    healthcheck: () => [
      "CMD-SHELL",
      "mongosh --quiet --eval 'db.adminCommand({ping:1}).ok' || exit 1",
    ],
    image: DEFAULT_DATABASE_IMAGE.mongo,
    passwordChange: {
      input: ({ password, rootUser }) =>
        [
          'const conn = Mongo("mongodb://127.0.0.1:27017/admin");',
          'const admin = conn.getDB("admin");',
          `if (!admin.auth(${JSON.stringify(rootUser)}, process.env.NODDLE_CUR)) {`,
          '  throw new Error("authentication with the current password failed");',
          "}",
          `admin.changeUserPassword(${JSON.stringify(rootUser)}, ${JSON.stringify(password)});`,
          "",
        ].join("\n"),
      script: ({ secretPath }) =>
        `umask 077 && cat > /tmp/np.js && NODDLE_CUR="$(cat ${secretPath})" mongosh --quiet --nodb --file /tmp/np.js; rc=$?; rm -f /tmp/np.js; exit $rc`,
    },
    port: DATABASE_PORT.mongo,
    secretFile: "mongo_password",
    secretMode: SECRET_MODE_WORLD_READ_ONLY,
    volumePath: DEFAULT_DATABASE_VOLUME_PATH.mongo,
  },
  mysql: {
    connectionUrl: ({
      databaseName,
      host,
      password,
      portOverride,
      rootUser,
    }) => {
      const port = portOverride ?? DATABASE_PORT.mysql;
      const dbName = databaseName ?? rootUser;
      return `mysql://${rootUser}:${password}@${host}:${port}/${dbName}`;
    },
    env: ({ databaseName, rootUser, secretPath }) => [
      `MYSQL_ROOT_PASSWORD_FILE=${secretPath}`,
      `MYSQL_DATABASE=${databaseName ?? rootUser}`,
      ...(rootUser && rootUser !== "root"
        ? [`MYSQL_USER=${rootUser}`, `MYSQL_PASSWORD_FILE=${secretPath}`]
        : []),
    ],
    healthcheck: ({ secretPath }) => [
      "CMD-SHELL",
      `umask 077 && printf '[client]\\npassword=%s\\n' "$(cat ${secretPath})" > /tmp/hc.cnf && mysqladmin --defaults-extra-file=/tmp/hc.cnf ping -h 127.0.0.1 -u root; rc=$?; rm -f /tmp/hc.cnf; exit $rc`,
    ],
    image: DEFAULT_DATABASE_IMAGE.mysql,
    passwordChange: mysqlFamilyPasswordChange("mysql"),
    port: DATABASE_PORT.mysql,
    secretFile: "mysql_password",
    volumePath: DEFAULT_DATABASE_VOLUME_PATH.mysql,
  },
  postgres: {
    connectionUrl: ({
      databaseName,
      host,
      password,
      portOverride,
      rootUser,
    }) => {
      const port = portOverride ?? DATABASE_PORT.postgres;
      const dbName = databaseName ?? rootUser;
      return `postgresql://${rootUser}:${password}@${host}:${port}/${dbName}`;
    },
    env: ({ databaseName, rootUser, secretPath }) => [
      `POSTGRES_USER=${rootUser}`,
      `POSTGRES_PASSWORD_FILE=${secretPath}`,
      `POSTGRES_DB=${databaseName ?? rootUser}`,
    ],
    healthcheck: ({ databaseName, rootUser }) => [
      "CMD-SHELL",
      `pg_isready -U ${rootUser} -d ${databaseName} || exit 1`,
    ],
    image: DEFAULT_DATABASE_IMAGE.postgres,
    passwordChange: {
      input: ({ password, rootUser }) =>
        `\\set pw '${psqlSetLiteral(password)}'\nALTER USER "${rootUser}" WITH PASSWORD :'pw';\n`,
      script: ({ rootUser }) =>
        `exec psql -v ON_ERROR_STOP=1 -U ${rootUser} -d postgres`,
    },
    port: DATABASE_PORT.postgres,
    secretFile: "postgres_password",
    volumePath: DEFAULT_DATABASE_VOLUME_PATH.postgres,
  },
  redis: {
    command: ({ secretPath }) => [
      "sh",
      "-c",
      `{ printf 'requirepass '; cat ${secretPath}; printf '\\nappendonly yes\\n'; } > /tmp/redis.conf && exec redis-server /tmp/redis.conf`,
    ],
    connectionUrl: ({ host, password, portOverride }) => {
      const port = portOverride ?? DATABASE_PORT.redis;
      return `redis://default:${password}@${host}:${port}`;
    },
    env: () => [],
    healthcheck: ({ secretPath }) => [
      "CMD-SHELL",
      `REDISCLI_AUTH="$(cat ${secretPath})" redis-cli ping || exit 1`,
    ],
    image: DEFAULT_DATABASE_IMAGE.redis,
    passwordChange: {
      input: ({ password }) => password,
      script: ({ secretPath }) =>
        `REDISCLI_AUTH="$(cat ${secretPath})" exec redis-cli -x CONFIG SET requirepass`,
    },
    port: DATABASE_PORT.redis,
    secretFile: "redis_password",
    volumePath: DEFAULT_DATABASE_VOLUME_PATH.redis,
  },
};

export function passwordChangeFor(
  engine: DatabaseEngine,
  params: { password: string; rootUser: string }
): { input: string; script: string } {
  const secretPath = secretPathFor(engine);
  const change = ENGINE_SPECS[engine].passwordChange;
  return {
    input: change.input(params),
    script: change.script({ rootUser: params.rootUser, secretPath }),
  };
}

export function connectionUrlFor(
  engine: DatabaseEngine,
  params: ConnectionUrlParams
): string {
  return ENGINE_SPECS[engine].connectionUrl(params);
}

export function secretPathFor(engine: DatabaseEngine): string {
  return `/run/secrets/${ENGINE_SPECS[engine].secretFile}`;
}

export function reservedEnvKeys(
  engine: DatabaseEngine,
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
    .toSorted();
}
