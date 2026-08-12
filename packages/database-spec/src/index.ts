import type { DatabaseEngine } from "@noddle/shared/database-engine-types";

/**
 * The default, pinned image — frozen on the row at creation time.
 * See the comment on `DEFAULT_DATABASE_IMAGE` in the architecture review (C5).
 */
export const DEFAULT_DATABASE_IMAGE: Record<DatabaseEngine, string> = {
  mariadb: "mariadb:11",
  mongo: "mongo:7",
  mysql: "mysql:8",
  postgres: "postgres:17-alpine",
  redis: "redis:7-alpine",
};

/** The port the engine listens on, in its official image. */
export const DATABASE_PORT: Record<DatabaseEngine, number> = {
  mariadb: 3306,
  mongo: 27_017,
  mysql: 3306,
  postgres: 5432,
  redis: 6379,
};

/** Default container path for the primary named volume. */
export const DEFAULT_DATABASE_VOLUME_PATH: Record<DatabaseEngine, string> = {
  mariadb: "/var/lib/mysql",
  mongo: "/data/db",
  mysql: "/var/lib/mysql",
  postgres: "/var/lib/postgresql/data",
  redis: "/data",
};

export interface EngineParams {
  /** `null` for engines without a notion of a named database (Redis). */
  databaseName: string | null;
  /** `null` for engines without a notion of a user (Redis). */
  rootUser: string | null;
  /** The mounted secret's PATH, never the plaintext password. */
  secretPath: string;
}

export interface ConnectionUrlParams {
  databaseName: string | null;
  host: string;
  password: string;
  portOverride?: number;
  rootUser: string | null;
}

/**
 * In-container password rotation: the NEW password travels on stdin only.
 * The script itself must never embed it — `docker top` / argv would leak it.
 *
 * `rootUser` is already constrained to a safe identifier by the caller.
 */
export interface PasswordChangeSpec {
  input: (params: { password: string; rootUser: string }) => string;
  script: (params: { rootUser: string; secretPath: string }) => string;
}

export interface EngineSpec {
  // Receives the mounted secret's PATH (/run/secrets/…), never the plaintext
  // password — that alone would end up in `docker service inspect`.
  command?: (params: EngineParams) => string[];
  connectionUrl: (params: ConnectionUrlParams) => string;
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
  /**
   * How to rotate the root password INSIDE a running container.
   * Owned here so a sixth engine can't compile without a rotation path.
   */
  passwordChange: PasswordChangeSpec;
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

/** Escapes a SQL string literal for MySQL/MariaDB (apostrophe AND backslash). */
function mysqlLiteral(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("'", "''");
}

/** Escapes a value for psql's `\set` metacommand. */
function psqlSetLiteral(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

function mysqlFamilyPasswordChange(
  clientBinary: "mariadb" | "mysql"
): PasswordChangeSpec {
  return {
    // THREE accounts, each with `IF EXISTS` — the official image creates
    // `root@localhost` IN ADDITION TO `root@%`. A password change that
    // leaves an account behind isn't a password change.
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
    // Current password from the mounted secret via a config file — never
    // `-p` / `MYSQL_PWD` (argv / `/proc/<pid>/environ`).
    script: ({ secretPath }) =>
      `umask 077 && { printf '[client]\\npassword='; cat ${secretPath}; printf '\\n'; } > /tmp/np.cnf && ${clientBinary} --defaults-extra-file=/tmp/np.cnf --user=root; rc=$?; rm -f /tmp/np.cnf; exit $rc`,
  };
}

export const SECRET_MODE_OWNER_READ_ONLY = 0o400;
/** See `EngineSpec.secretMode`: required by MongoDB's entrypoint. */
export const SECRET_MODE_WORLD_READ_ONLY = 0o444;

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
export const ENGINE_SPECS: Record<DatabaseEngine, EngineSpec> = {
  // MySQL and MariaDB are twins apart from a prefix (`MYSQL_` / `MARIADB_`),
  // but their blocks are still written out in full rather than generated by a
  // shared function: these are two products that have diverged, their images
  // already don't ship the same binaries, and factoring them together would
  // give the false impression they'll move in lockstep.
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
    passwordChange: {
      // JS on stdin written to a file: `--eval` would put the new password
      // in argv. Current password stays in NODDLE_CUR for the one process.
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
    passwordChange: {
      // No password: local socket is `trust` in the official image.
      // `ON_ERROR_STOP=1`: without it psql exits 0 after a rejected ALTER.
      // `\set` then `:'pw'`: psql quotes the value — no hand-stitched SQL.
      // `rootUser` is asserted safe by the caller (letters/digits/_ only).
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
    connectionUrl: ({ host, password, portOverride }) => {
      const port = portOverride ?? DATABASE_PORT.redis;
      return `redis://default:${password}@${host}:${port}`;
    },
    env: () => [],
    // `REDISCLI_AUTH`, never `-a`: the same rule already applied for the
    // backup dump — `-a` exposes the password in the process's argv.
    healthcheck: ({ secretPath }) => [
      "CMD-SHELL",
      `REDISCLI_AUTH="$(cat ${secretPath})" redis-cli ping || exit 1`,
    ],
    image: DEFAULT_DATABASE_IMAGE.redis,
    passwordChange: {
      // `-x` reads the last argument from stdin — new password never in argv.
      // No trailing newline: `-x` takes stdin as-is.
      input: ({ password }) => password,
      script: ({ secretPath }) =>
        `REDISCLI_AUTH="$(cat ${secretPath})" exec redis-cli -x CONFIG SET requirepass`,
    },
    port: DATABASE_PORT.redis,
    secretFile: "redis_password",
    volumePath: DEFAULT_DATABASE_VOLUME_PATH.redis,
  },
};

/**
 * Builds the in-container password-change script + stdin payload for an engine.
 * A sixth engine fails to compile on ENGINE_SPECS, not at runtime here.
 */
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

/**
 * Where the password is mounted INSIDE the container.
 *
 * Exported because changing the password needs to read the CURRENT secret
 * from here — authenticating with the engine without the worker having to
 * decrypt it or have it travel.
 */
export function secretPathFor(engine: DatabaseEngine): string {
  return `/run/secrets/${ENGINE_SPECS[engine].secretFile}`;
}

/**
 * The keys an engine reserves for itself — so the screen can name them.
 * Derived from what the engine produces, never kept by hand.
 */
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
    .sort();
}
