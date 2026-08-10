export const DATABASE_ENGINES = [
  "postgres",
  "mysql",
  "mariadb",
  "mongo",
  "redis",
] as const;

export type DatabaseEngine = (typeof DATABASE_ENGINES)[number];

/**
 * The default, pinned image.
 *
 * **It's resolved and WRITTEN at creation time, never read again at
 * deploy time.** It's the only safe form: as long as `databases.image`
 * was `null` and the worker fell back here, changing this table would
 * make an EXISTING database restart on a different major version, on top
 * of the volume written by the previous one. Postgres flatly refuses a
 * data directory from an older version; other engines would do worse, by
 * starting up anyway.
 *
 * Same principle as `stacks.swarm_name` and `REGISTRY_HOST`: a value that
 * describes what's RUNNING is frozen at creation and read back afterward.
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

/**
 * Default container path for the primary named volume.
 *
 * Kept here (not only in the worker) so Advanced → Volumes can show and
 * edit the path without importing worker code.
 */
export const DEFAULT_DATABASE_VOLUME_PATH: Record<DatabaseEngine, string> = {
  mariadb: "/var/lib/mysql",
  mongo: "/data/db",
  mysql: "/var/lib/mysql",
  postgres: "/var/lib/postgresql/data",
  redis: "/data",
};

/**
 * The default admin user: the name of the ENGINE, never the product's.
 *
 * It used to be `noddle` for every database, which was a Noddle
 * invention. The default adopted is `postgres`, `mysql`, `mariadb`,
 * `mongo`… — a choice that's correct for a reason that's not arbitrary at
 * all: it's the account the official image creates anyway, the one the
 * engine's documentation names, and the one any third-party tool tries
 * first. A product name in a connection string doesn't inform anyone.
 *
 * `null` for engines with no notion of a user.
 */
export const DEFAULT_DATABASE_USER: Record<DatabaseEngine, string | null> = {
  mariadb: "mariadb",
  mongo: "mongo",
  mysql: "mysql",
  postgres: "postgres",
  redis: null,
};

/**
 * Does the engine have a NAMED database, distinct from its server?
 *
 * Redis only has database numbers, so no name and no user.
 */
export const HAS_NAMED_DATABASE: Record<DatabaseEngine, boolean> = {
  mariadb: true,
  mongo: true,
  mysql: true,
  postgres: true,
  redis: false,
};

/** The displayed label. Separate from the technical name, which is a key, not a word. */
export const DATABASE_ENGINE_LABEL: Record<DatabaseEngine, string> = {
  mariadb: "MariaDB",
  mongo: "MongoDB",
  mysql: "MySQL",
  postgres: "PostgreSQL",
  redis: "Redis",
};

/**
 * The prefix the engine reserves for itself in the container's environment.
 *
 * This is how the official image receives its user, its database and its
 * password — so the values Noddle writes itself, and that its row and its
 * secret reflect. A manually entered variable that overwrote one of them
 * would make the database start with an identifier Noddle doesn't know
 * about, while the screen kept showing the old one.
 *
 * Here and not only in the worker because BOTH need it: the worker so the
 * engine wins on merge, the web app to REJECT the input with a message
 * rather than accepting it and silently ignoring it. The worker stays the
 * authority — its merge is computed on the keys it actually produces, so
 * it can't be derived from this list.
 */
export const ENGINE_ENV_PREFIX: Record<DatabaseEngine, string> = {
  mariadb: "MARIADB_",
  mongo: "MONGO_",
  mysql: "MYSQL_",
  postgres: "POSTGRES_",
  redis: "REDIS_",
};
